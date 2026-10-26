#!/usr/bin/env node
/**
 * Mints a real Firebase ID token (with a phone_number claim) for local/dev
 * testing of authed endpoints — no OTP flow needed.
 *
 * Path: firebase-admin (via your `gcloud` ADC) creates/finds a phone-auth
 * user -> signs a custom token (requires roles/iam.serviceAccountTokenCreator
 * on the runtime SA, see below) -> exchanges it at Identity Toolkit for a
 * real ID token. Prints ONLY the ID token to stdout — nothing else touches
 * stdout, so `TOKEN=$(node scripts/dev/mint-token.mjs)` just works.
 *
 * One-time setup per gcloud identity: grant yourself token-creator on the
 * runtime SA so you can sign custom tokens:
 *   gcloud iam service-accounts add-iam-policy-binding \
 *     laanya-api-run@laanya-prod.iam.gserviceaccount.com \
 *     --member="user:$(gcloud config get-value account)" \
 *     --role=roles/iam.serviceAccountTokenCreator --project laanya-prod
 *
 * Usage:
 *   node scripts/dev/mint-token.mjs                  # test number +919000000000
 *   node scripts/dev/mint-token.mjs +919876543210     # any phone number
 */
import { execFileSync } from 'node:child_process'
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const PROJECT_ID = 'laanya-prod'
const RUNTIME_SA = 'laanya-api-run@laanya-prod.iam.gserviceaccount.com'
// Firebase's auto-created Browser key — used only to call the public
// signInWithCustomToken endpoint, never to access anything privileged.
const BROWSER_API_KEY_RESOURCE =
  'projects/69070121252/locations/global/keys/0f04625d-1937-4637-b11b-2cc7f83db6a8'
const phone = process.argv[2] ?? '+919000000000'

if (!/^\+\d{8,15}$/.test(phone)) {
  console.error(`mint-token: "${phone}" doesn't look like E.164 (e.g. +919000000000)`)
  process.exit(1)
}

const apiKey = execFileSync(
  'gcloud',
  ['services', 'api-keys', 'get-key-string', BROWSER_API_KEY_RESOURCE, '--format=value(keyString)'],
  { encoding: 'utf8' }
).trim()

const app = initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT_ID,
  serviceAccountId: RUNTIME_SA,
})
const auth = getAuth(app)

let user
try {
  user = await auth.getUserByPhoneNumber(phone)
} catch {
  user = await auth.createUser({ phoneNumber: phone })
}

let customToken
try {
  customToken = await auth.createCustomToken(user.uid)
} catch (err) {
  if (String(err?.message ?? err).includes('signBlob')) {
    console.error(
      `mint-token: missing permission to sign custom tokens.\n` +
        `Run once:\n` +
        `  gcloud iam service-accounts add-iam-policy-binding ${RUNTIME_SA} \\\n` +
        `    --member="user:$(gcloud config get-value account)" \\\n` +
        `    --role=roles/iam.serviceAccountTokenCreator --project ${PROJECT_ID}`
    )
    process.exit(1)
  }
  throw err
}

const res = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  }
)
if (!res.ok) {
  const body = await res.json().catch(() => ({}))
  console.error(`mint-token: token exchange failed (${res.status}): ${body?.error?.message ?? ''}`)
  process.exit(1)
}
const { idToken } = await res.json()
process.stdout.write(idToken + '\n')
