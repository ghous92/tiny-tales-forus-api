#!/usr/bin/env bash
#
# Provision the Cloud Scheduler jobs that drive `/v1/internal/sweeps/*`
# (docs/SPEC-SWEEP-AUTOMATION.md).
#
# Idempotent: every step is create-or-update, so re-running after a cadence
# change or a service-URL change converges rather than erroring. Safe to run
# against an environment that already has the jobs.
#
# This is infrastructure, not a deploy — it does NOT need a release. It also
# does nothing on its own: the jobs will call the API and get
# `200 {ran: false, reason: "fulfilment_disabled"}` until the `fulfilment.*`
# config says otherwise. Provisioning first and enabling later is the intended
# order, so the schedule is proven green before it can book a real parcel.
#
# Usage:
#   scripts/provision-schedulers.sh staging
#   scripts/provision-schedulers.sh prod
#   DRY_RUN=1 scripts/provision-schedulers.sh prod    # print, change nothing
#
# Prerequisites: `gcloud auth login` with rights to create service accounts,
# IAM bindings and scheduler jobs in `tinytalesforus-prod`.

set -euo pipefail

ENVIRONMENT="${1:-}"
PROJECT="tinytalesforus-prod"
# Cloud Run and Cloud Scheduler both live here. NOT asia-south1 — that region
# is empty and querying it is how you conclude there are no jobs at all.
REGION="asia-southeast1"
SA_NAME="tinytales-scheduler"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

# AUDIENCE must match SCHEDULER_OIDC_AUDIENCE in deploy.yml EXACTLY, and the two
# environments deliberately differ. An arbitrary stable string rather than the
# service URL: the API answers on the run.app host, on www.tinytalesforus.com/api and
# on localhost, and an audience tied to one of them silently accepts tokens
# minted for the others. Distinct per environment because both services trust
# the SAME service account — with one shared audience, a staging job's token
# would be replayable against production, which is the one environment where a
# spurious manifest sweep books real parcels.
case "$ENVIRONMENT" in
  staging)
    SERVICE="tinytales-api-staging"
    PREFIX="tinytales-sweep-staging"
    AUDIENCE="tinytales-api-sweeps-staging"
    ;;
  prod)
    SERVICE="tinytales-api"
    PREFIX="tinytales-sweep"
    AUDIENCE="tinytales-api-sweeps"
    ;;
  *)
    echo "usage: $0 <staging|prod>" >&2
    exit 2
    ;;
esac

run() {
  if [[ -n "${DRY_RUN:-}" ]]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# Resolve the service URL rather than hardcoding it: the `*-h57blldwiq-as`
# hash is stable in practice but is not a contract, and a job pointed at a
# stale URL fails silently as a 404 the scheduler reports as a red run nobody
# is watching yet.
BASE_URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
if [[ -z "$BASE_URL" ]]; then
  echo "could not resolve the URL for Cloud Run service '$SERVICE'" >&2
  exit 1
fi
echo "environment : $ENVIRONMENT"
echo "service     : $SERVICE"
echo "base url    : $BASE_URL"
echo "audience    : $AUDIENCE"
echo "invoker     : $SA_EMAIL"
echo

# ── 1. The scheduler's own identity ────────────────────────────────────────
# A dedicated service account, not the Cloud Run runtime one
# (`tinytales-api-run@`). The API's allowlist is `SCHEDULER_SERVICE_ACCOUNTS`, and
# an identity that both runs the service and calls its privileged internal
# routes collapses two trust boundaries into one for no gain.
if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  echo "service account exists: $SA_EMAIL"
else
  echo "creating service account: $SA_EMAIL"
  run gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT" \
    --display-name="Cloud Scheduler → tinytales-api background sweeps"
fi

# `roles/run.invoker` is belt-and-braces here: the service currently allows
# unauthenticated traffic (Cloudflare fronts it), so Cloud Run itself does not
# check IAM and the API's own allowlist is what refuses. Granting it anyway
# means the day the service is closed to unauthenticated callers, the sweeps do
# not silently stop.
echo "granting roles/run.invoker on $SERVICE"
run gcloud run services add-iam-policy-binding "$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker" \
  --quiet

# ── 2. The jobs ────────────────────────────────────────────────────────────
#
# Cadences are chosen against what each sweep costs and how stale its work is
# allowed to get, not by picking a round number:
#
#  manifest          */15  — the gap between "customer paid" and "parcel booked".
#                            The only one a shopper can feel.
#  reconcile         hourly — a safety net under the scan webhook, and the thing
#                            that makes push an optimisation rather than a
#                            dependency. `reconcileStaleMinutes` is 180, so this
#                            polls each in-flight parcel at most a few times per
#                            stale window; Delhivery's tracking limit is 750
#                            requests / 5 min / IP and `reconcileBatchSize` is
#                            100, so an hourly run cannot approach it.
#  invoice-emails    */30  — a customer-visible retry, but a slow one; nothing
#                            downstream waits on it.
#  ops-notifications */10  — an operator alert is worth little late. Also the
#                            sweep that will deliver the whole backlog the
#                            moment Meta approves `order_paid_ops`.
#  payments-recover  */30  — the money one. A payment whose /verify AND webhook
#                            were both lost leaves the shopper charged with no
#                            order, and nothing else in the system will ever
#                            notice. Rows are only eligible after 15 minutes
#                            (RECOVER_STALE_AFTER_MS), so a faster cadence buys
#                            nothing: it would re-scan the same too-young rows
#                            and wake Neon twice as often for it.
#
# The three ENABLED jobs currently run '0 4 * * *', not the cadences reasoned
# about above — see the PRE-LAUNCH CADENCE note below the upsert_job helper.
#
# `attempt-deadline` is 300s (the sweeps are bounded loops over ≤100 rows, each
# possibly a carrier HTTP call) and retries are capped at 3: a sweep that fails
# is picked up whole by the next run, so grinding retries buy nothing and turn
# one bad carrier minute into a thunderstorm.
upsert_job() {
  local name="$1" path="$2" schedule="$3" description="$4"
  local full="${PREFIX}-${name}"
  local verb="create"
  if gcloud scheduler jobs describe "$full" \
      --project="$PROJECT" --location="$REGION" >/dev/null 2>&1; then
    verb="update"
  fi

  echo "${verb}: ${full}  [${schedule}]  -> ${path}"
  run gcloud scheduler jobs "$verb" http "$full" \
    --project="$PROJECT" \
    --location="$REGION" \
    --schedule="$schedule" \
    --time-zone="Asia/Kolkata" \
    --uri="${BASE_URL}${path}" \
    --http-method=POST \
    --oidc-service-account-email="$SA_EMAIL" \
    --oidc-token-audience="$AUDIENCE" \
    --attempt-deadline=300s \
    --max-retry-attempts=3 \
    --min-backoff=30s \
    --max-backoff=300s \
    --description="$description" \
    --quiet
}

# Cadences are deliberately aligned to the same minute (:00 / :30). Neon bills
# a 5-minute minimum every time a sweep wakes the compute, so four jobs on four
# interleaved schedules cost far more than four jobs firing together. Keep new
# sweeps on '*/30' unless there is a real latency requirement, and prefer
# widening an existing cadence over adding a faster one.
#
# None of these sweeps are on the delivery path — the payment webhook sends ops
# notifications and invoice emails inline (routes/payments.ts). These drain
# retries and backlog, so a 30-minute cadence costs no first-attempt latency.
upsert_job manifest /v1/internal/sweeps/manifest '*/30 * * * *' \
  'Hand every paid-but-unbooked order to the carrier'
upsert_job reconcile /v1/internal/sweeps/reconcile '0 * * * *' \
  'Pull tracking for shipments the scan webhook has gone quiet on'
# DAILY BACKSTOP CADENCE (set 2026-08-23, permanent as of the Cloud Tasks
# rollout — see docs/WIP-EVENT-DRIVEN-SWEEPS.md). One Neon wake every 24h
# instead of 48 on a shared minute: compute floor ~4h/day -> ~5min/day
# (~$4.5/mo -> ~$0.2/mo).
#
# This is no longer "restore before real order volume": Cloud Tasks now
# enqueues a debounced drain for each of these the moment a delivery fails or
# a deadline passes, so retry latency is ~5 min on the fast path regardless of
# this cadence. These three stay at 24h forever as the belt-and-braces floor —
# the thing that still runs if an enqueue fails, a task is purged, or a row
# becomes eligible through a path no enqueue is wired into.
upsert_job invoice-emails /v1/internal/sweeps/invoice-emails '0 4 * * *' \
  'Retry customer invoice copies still owed an email'
upsert_job ops-notifications /v1/internal/sweeps/ops-notifications '0 4 * * *' \
  'Drain the ops WhatsApp notification outbox'
# Shares its minute with the two sweeps above deliberately — the Neon compute is
# already awake for those, so this job's marginal compute cost is ~zero. Moving
# it to its own minute would roughly double the bill on its own.
upsert_job payments-recover /v1/internal/sweeps/payments-recover '0 4 * * *' \
  'Reconcile payments stuck pending against Razorpay (recovers lost captures)'

echo
echo "done. Verify with:"
echo "  gcloud scheduler jobs list --project=$PROJECT --location=$REGION"
echo "  gcloud scheduler jobs run ${PREFIX}-manifest --project=$PROJECT --location=$REGION"
echo
echo "A freshly-provisioned job answers 200 {ran:false,reason:\"fulfilment_disabled\"}"
echo "until fulfilment.enabled/mode say otherwise. That is the expected first result."
