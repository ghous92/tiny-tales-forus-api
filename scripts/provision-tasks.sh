#!/usr/bin/env bash
#
# Provision the Cloud Tasks queue that debounces `/v1/internal/sweeps/*`
# retries (docs/WIP-EVENT-DRIVEN-SWEEPS.md). Companion to
# `provision-schedulers.sh`, which provisions the daily backstop cron this
# queue supplements — never replaces.
#
# Idempotent: enables the API if needed, then create-or-update on the queue
# and each IAM binding. Safe to re-run against an environment that already
# has them.
#
# Usage:
#   scripts/provision-tasks.sh staging
#   scripts/provision-tasks.sh prod
#   DRY_RUN=1 scripts/provision-tasks.sh prod    # print, change nothing
#
# Prerequisites: `gcloud auth login` with rights to enable APIs, create
# queues and grant IAM bindings in `tinytalesforus-prod`. Staging and prod share this
# one project — see provision-schedulers.sh's PROJECT comment.
#
# This script provisions infrastructure only. It does NOT set the `TASKS_*`
# env vars on the Cloud Run service — do that (and deploy) as a separate,
# deliberate step per docs/WIP-EVENT-DRIVEN-SWEEPS.md §7 step 3. Until those
# vars are set, `buildApp` resolves no enqueuer and behaviour is unchanged:
# cron-only, exactly as documented.

set -euo pipefail

ENVIRONMENT="${1:-}"
PROJECT="tinytalesforus-prod"
REGION="asia-southeast1"
# The runtime identity of the Cloud Run service itself — the one that calls
# `tasks.create`, not the one the task later authenticates AS when it calls
# back in (that's `tinytales-scheduler@`, already provisioned by
# provision-schedulers.sh).
RUN_SA="tinytales-api-run@${PROJECT}.iam.gserviceaccount.com"
SCHEDULER_SA="tinytales-scheduler@${PROJECT}.iam.gserviceaccount.com"

# ONE QUEUE PER ENVIRONMENT, and this is load-bearing rather than tidiness.
# Task names (`src/lib/tasks.ts`, `taskNameFor`) are `<kind>-<bucket epoch>` —
# deliberately derived from the fire time so that many triggers in one window
# collapse to one task. They carry NO environment component. Staging and prod
# are two Cloud Run services in this one project, so a shared queue would mean
# staging's `invoice-emails-<t>` and prod's `invoice-emails-<t>` are the same
# task name: the second enqueue gets 409, which the enqueuer correctly treats
# as "this window is already covered" — except it isn't. Whichever service
# enqueued first decides the target URL, and the other environment's drain
# silently never happens, waiting on the daily backstop instead.
#
# Same reasoning as the distinct-audience-per-environment split in
# provision-schedulers.sh: two environments trusting one shared identifier is
# how one of them quietly stops working.
case "$ENVIRONMENT" in
  staging)
    QUEUE="tinytales-sweeps-staging"
    SERVICE="tinytales-api-staging"
    ;;
  prod)
    QUEUE="tinytales-sweeps"
    SERVICE="tinytales-api"
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

echo "environment : $ENVIRONMENT"
echo "project     : $PROJECT"
echo "service     : $SERVICE"
echo "queue       : $QUEUE"
echo "region      : $REGION"
echo

# ── 1. The API ───────────────────────────────────────────────────────────
# Project-wide, so only the first run of either environment does anything.
# Safe to re-run: `services enable` on an already-enabled API is a no-op.
if gcloud services list --enabled --project="$PROJECT" \
    --filter='config.name=cloudtasks.googleapis.com' \
    --format='value(config.name)' | grep -q cloudtasks; then
  echo "Cloud Tasks API already enabled"
else
  echo "enabling Cloud Tasks API"
  run gcloud services enable cloudtasks.googleapis.com --project="$PROJECT"
fi

# ── 2. The queue ─────────────────────────────────────────────────────────
# Rate limits sized for our volume, not GCP defaults: this queue exists to
# debounce failures, not to sustain throughput, so `--max-concurrent-dispatches`
# stays low enough that a burst of enqueues cannot itself become a Neon
# thunderstorm. `--max-attempts` / backoff are Cloud Tasks' own retry, layered
# under the debounce — a dispatch failure (not a 200/409 from the sweep route)
# still gets retried without needing a new task name.
#
# Backoffs are in seconds, not `1h`: the Cloud Tasks API rejects any duration
# unit other than `s` with an INVALID_ARGUMENT naming the protobuf field.
if gcloud tasks queues describe "$QUEUE" \
    --project="$PROJECT" --location="$REGION" >/dev/null 2>&1; then
  echo "updating queue: $QUEUE"
  run gcloud tasks queues update "$QUEUE" \
    --project="$PROJECT" --location="$REGION" \
    --max-attempts=5 --min-backoff=30s --max-backoff=3600s \
    --max-dispatches-per-second=5 --max-concurrent-dispatches=5
else
  echo "creating queue: $QUEUE"
  run gcloud tasks queues create "$QUEUE" \
    --project="$PROJECT" --location="$REGION" \
    --max-attempts=5 --min-backoff=30s --max-backoff=3600s \
    --max-dispatches-per-second=5 --max-concurrent-dispatches=5
fi

# ── 3. IAM — three bindings, easy to miss ────────────────────────────────
# (1) is the one that shows up as a queue-shaped permission error. (2) is the
# one that shows up as a service-account-shaped error naming an SA that looks
# unrelated to the failing call — see src/lib/tasks.ts's doc comment on
# createCloudTasksEnqueuer. (3) is already granted by provision-schedulers.sh
# and is listed here only so this script is a complete, standalone record of
# what task delivery requires.
echo "granting roles/cloudtasks.enqueuer on $QUEUE to $RUN_SA"
run gcloud tasks queues add-iam-policy-binding "$QUEUE" \
  --project="$PROJECT" --location="$REGION" \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/cloudtasks.enqueuer" \
  --quiet

echo "granting roles/iam.serviceAccountUser on $SCHEDULER_SA to $RUN_SA"
run gcloud iam service-accounts add-iam-policy-binding "$SCHEDULER_SA" \
  --project="$PROJECT" \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --quiet

echo "(3) roles/run.invoker for $SCHEDULER_SA — already granted by provision-schedulers.sh"

echo
echo "done. Verify with:"
echo "  gcloud tasks queues describe $QUEUE --project=$PROJECT --location=$REGION"
echo
echo "Queue is live but inert until $SERVICE has TASKS_* env vars set (TASKS_QUEUE"
echo "must be '$QUEUE') and is redeployed — see docs/WIP-EVENT-DRIVEN-SWEEPS.md §7."
