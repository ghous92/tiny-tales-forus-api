/**
 * Shared guard for seed scripts that write data which must never reach a real
 * customer: placeholder courier rates and estimated product weights.
 *
 * Both are *plausible* numbers. That is what makes them dangerous — a wrong
 * rate card does not throw, it just quietly charges the wrong amount forever.
 * So the guard fails CLOSED: it requires `APP_ENV` to be explicitly
 * `development`, and an UNSET `APP_ENV` is refused rather than assumed safe.
 *
 * This deliberately disagrees with `src/env.ts`, where `APP_ENV` defaults to
 * `development` — the API server defaulting to the least-privileged mode is
 * correct, but a seed script inheriting that default would run happily against
 * a production `DATABASE_URL` on any machine that never set the variable. The
 * same reasoning the admin SPA uses for `X-TinyTales-Env`: silence is not evidence
 * of safety, so silence gets refused.
 *
 * `ALLOW_NON_DEV_SEED=1` is the escape hatch for the one legitimate case —
 * seeding a throwaway staging DB — and it has to be typed on purpose.
 */

/** Refuse to continue unless this is demonstrably a development database. */
export function assertDevOnly(scriptName: string): void {
  const appEnv = process.env.APP_ENV?.trim()

  if (appEnv === 'development') return

  if (process.env.ALLOW_NON_DEV_SEED === '1') {
    console.warn(
      `${scriptName}: ALLOW_NON_DEV_SEED=1 with APP_ENV=${appEnv ?? '(unset)'} — writing placeholder data to a NON-development database.`
    )
    return
  }

  const reason =
    appEnv === undefined || appEnv === ''
      ? 'APP_ENV is not set'
      : `APP_ENV is "${appEnv}", not "development"`

  console.error(
    `${scriptName}: refusing to run — ${reason}.\n` +
      '\n' +
      'This script writes PLACEHOLDER data (estimated weights / unnegotiated\n' +
      'courier rates) that would produce wrong prices against real orders.\n' +
      '\n' +
      'For a local dev database:   APP_ENV=development npm run <script>\n' +
      'For a throwaway staging DB: ALLOW_NON_DEV_SEED=1 npm run <script>'
  )
  process.exit(1)
}
