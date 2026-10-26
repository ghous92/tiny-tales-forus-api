#!/usr/bin/env tsx
/**
 * `npm run config:doctor` — what differs between deployments' `app_config`, and
 * which of those differences are supposed to be there.
 *
 * ## Why this is a report and not a sync
 *
 * "Copy prod's config to the other environments" is the obvious tool to build
 * and the wrong one. Three keys MUST differ per environment, and every one of
 * them fails quietly rather than loudly:
 *
 *   - `shipping.serviceableStates` — the legal scope fence. Widening it is a
 *     deliberate decision with its own script (`open-shipping-state-fence.ts`)
 *     precisely so it can never ride in as a side effect of someone else's
 *     task. A sync that pushed a test environment's open fence to prod would
 *     start quoting shipping to states the business cannot serve.
 *   - `fulfilment.pickupLocationName` — matched against the registered
 *     Delhivery warehouse EXACTLY and case-sensitively, and Delhivery exposes
 *     no read-back. Prod's warehouse is not staging's. Copying one to the other
 *     produces a rejected manifest per order, forever, with no single failure
 *     to notice.
 *   - `ops.notifyNumbers` — a real person's phone. Seeded empty everywhere for
 *     that reason; an environment that inherits prod's list starts messaging
 *     an operator about test orders.
 *
 * So the divergence itself is not the problem — UNDOCUMENTED divergence is.
 * This reports every difference, subtracts the ones declared below, and exits
 * non-zero on whatever is left. An empty report means the environments agree
 * everywhere they are meant to.
 *
 * The one thing it will write is a MISSING key, and only from
 * `CONFIG_DEFAULTS`:
 *
 *   npm run config:doctor                       # report, exit 1 on undeclared drift
 *   npm run config:doctor -- --fix              # insert missing keys at their defaults
 *   npm run config:doctor -- --env prod=$URL --env dev=$URL2
 *
 * `--fix` never overwrites an existing value, so a setting an operator tuned in
 * the admin panel survives it untouched — it is the same insert-only
 * `seedConfigDefaults` the seed scripts use. A key that is present but WRONG is
 * reported and left alone: that is an editorial decision, and the admin panel
 * writes an audit row naming who made it.
 *
 * With no `--env`, it inspects `DATABASE_URL_DIRECT ?? DATABASE_URL` alone.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { Db } from '../src/db/client.js'
import { appConfig } from '../src/db/schema.js'
import { CONFIG_DEFAULTS, seedConfigDefaults } from './seed-config.js'

/**
 * Keys that are SUPPOSED to differ between environments, with the reason.
 *
 * The reason is stored, not just the key, because the next person to read a
 * clean report needs to know why these are exempt — an unexplained allowlist
 * entry is indistinguishable from a bug someone silenced.
 */
export interface DivergentKey {
  why: string
  /**
   * Optional per-environment pin, as canonical JSON. Present when the
   * divergence is not merely allowed but SPECIFIED — the difference is then
   * still exempt from the drift count, while a value that stops matching its
   * pin fails the run like any other regression.
   *
   * Without this, declaring a key by-design silences it in both directions: a
   * prod deploy that quietly flipped `fulfilment.enabled` to false would read
   * as "expected divergence" and never be reported. An environment not listed
   * here is unconstrained.
   */
  expect?: Readonly<Record<string, string>>
}

export const DIVERGENT_BY_DESIGN: ReadonlyMap<string, DivergentKey> = new Map([
  [
    'shipping.serviceableStates',
    {
      why: 'the legal scope fence — widened only by open-shipping-state-fence.ts, never by a sync',
    },
  ],
  [
    'fulfilment.pickupLocationName',
    {
      why: 'each environment ships from its own registered Delhivery warehouse; a wrong string is a rejected manifest per order',
    },
  ],
  [
    'ops.notifyNumbers',
    { why: 'a real on-call phone number; test environments must not inherit it' },
  ],
  [
    'fulfilment.enabled',
    {
      why: 'live in prod and staging; off in dev, which has no registered warehouse to ship from',
      expect: { prod: 'true', staging: 'true', dev: 'false' },
    },
  ],
  [
    'fulfilment.mode',
    {
      why: "carrier in prod; 'manual' in staging and dev so no Delhivery manifest can be created outside prod",
      expect: { prod: '"carrier"', staging: '"manual"', dev: '"manual"' },
    },
  ],
])

/** One environment's `app_config`, as `key -> canonical JSON of the value`. */
export type ConfigSnapshot = ReadonlyMap<string, string>

export interface KeyDrift {
  key: string
  /**
   * `missing` — absent in at least one environment, present in another (or in
   * `CONFIG_DEFAULTS`). Fixable.
   * `value` — present everywhere, values disagree. Never auto-fixed.
   * `unknown` — in a database but not in `CONFIG_DEFAULTS`: either a key that
   * outlived its code, or a typo that has been silently inert since the day it
   * was written.
   */
  kind: 'missing' | 'value' | 'unknown'
  /** Per environment, in the order given. `undefined` means the key is absent. */
  values: Array<string | undefined>
  /** Set when the key is on {@link DIVERGENT_BY_DESIGN} — reported, not counted. */
  expected?: string
}

/**
 * Compare environments key by key. Pure, so the interesting cases are unit
 * tested rather than reproduced by hand against three live databases.
 *
 * `missing` is judged against the union of every environment's keys AND
 * `CONFIG_DEFAULTS`, so a key that no environment has yet — a default shipped
 * in code but never seeded anywhere — still surfaces. That is the case an
 * environment-to-environment diff alone cannot see.
 */
export function diffEnvironments(
  snapshots: ReadonlyArray<{ name: string; config: ConfigSnapshot }>,
  defaults: ReadonlySet<string> = new Set(CONFIG_DEFAULTS.map((d) => d.key))
): KeyDrift[] {
  const keys = [
    ...new Set([...snapshots.flatMap((s) => [...s.config.keys()]), ...defaults]),
  ].sort()

  const drift: KeyDrift[] = []
  for (const key of keys) {
    const values = snapshots.map((s) => s.config.get(key))
    const present = values.filter((v): v is string => v !== undefined)
    const declared = DIVERGENT_BY_DESIGN.get(key)
    // A pinned key is only exempt while every listed environment still holds
    // its pinned value; the moment one drifts off it, the exemption lapses and
    // the difference is reported like any other.
    const pinsHold =
      declared?.expect === undefined ||
      snapshots.every((snap, i) => {
        const pin = declared.expect?.[snap.name]
        return pin === undefined || values[i] === pin
      })
    const expected = declared !== undefined && pinsHold ? declared.why : undefined

    if (present.length === 0) {
      // In CONFIG_DEFAULTS, in no database.
      drift.push({ key, kind: 'missing', values })
      continue
    }
    if (!defaults.has(key)) {
      drift.push({ key, kind: 'unknown', values })
      continue
    }
    if (present.length !== values.length) {
      drift.push({ key, kind: 'missing', values })
      continue
    }
    if (new Set(present).size > 1) {
      drift.push({ key, kind: 'value', values, ...(expected ? { expected } : {}) })
    }
  }
  return drift
}

/** Drift that should fail the run — everything except declared divergence. */
export function undeclaredDrift(drift: readonly KeyDrift[]): KeyDrift[] {
  return drift.filter((d) => d.expected === undefined)
}

async function snapshot(connectionString: string): Promise<{ db: Db; pool: pg.Pool; config: ConfigSnapshot }> {
  const pool = new pg.Pool({ connectionString, max: 1 })
  const db = drizzle(pool) as unknown as Db
  const rows = await db.select({ key: appConfig.key, value: appConfig.value }).from(appConfig)
  return { db, pool, config: new Map(rows.map((r) => [r.key, JSON.stringify(r.value)])) }
}

/** `--env name=url`, repeatable. Falls back to the single DATABASE_URL. */
function parseTargets(argv: readonly string[]): Array<{ name: string; url: string }> {
  const targets: Array<{ name: string; url: string }> = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--env') continue
    const spec = argv[i + 1] ?? ''
    const at = spec.indexOf('=')
    if (at <= 0) throw new Error(`config:doctor: --env expects name=url, got "${spec}"`)
    targets.push({ name: spec.slice(0, at), url: spec.slice(at + 1) })
  }
  if (targets.length > 0) return targets
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL
  if (!url) throw new Error('config:doctor: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL, or pass --env name=url')
  return [{ name: 'local', url }]
}

/* eslint-disable no-console */
async function main(): Promise<void> {
  const fix = process.argv.includes('--fix')
  const targets = parseTargets(process.argv.slice(2))
  const opened = await Promise.all(
    targets.map(async (t) => ({ name: t.name, ...(await snapshot(t.url)) }))
  )

  try {
    const drift = diffEnvironments(opened.map((o) => ({ name: o.name, config: o.config })))
    const names = opened.map((o) => o.name)
    console.log(`config:doctor: ${names.join(', ')}`)
    console.log(`  keys: ${opened.map((o) => `${o.name}=${o.config.size}`).join('  ')}`)

    const show = (d: KeyDrift): void => {
      console.log(`  ${d.kind.toUpperCase()}  ${d.key}${d.expected ? '  (by design)' : ''}`)
      d.values.forEach((v, i) => console.log(`      ${names[i]}: ${v ?? '—'}`))
      // Printed for a MISSING key too, where `expected` is deliberately unset
      // (an absent key is a real gap and must still fail the run) — but the
      // reader is about to decide how to fill it, and this is the moment to say
      // "not by copying the value above".
      const why = d.expected ?? DIVERGENT_BY_DESIGN.get(d.key)?.why
      if (why) console.log(`      why they differ: ${why}`)
    }

    if (drift.length === 0) {
      console.log('  no drift')
    } else {
      for (const d of drift) show(d)
    }

    if (fix) {
      for (const target of opened) {
        // Insert-only: a key that exists keeps whatever value it has.
        const inserted = await seedConfigDefaults(target.db)
        console.log(
          inserted.length === 0
            ? `  ${target.name}: nothing to insert`
            : `  ${target.name}: inserted ${inserted.length} key(s): ${inserted.join(', ')}`
        )
      }
      return
    }

    const undeclared = undeclaredDrift(drift)
    if (undeclared.length > 0) {
      console.log(`\nconfig:doctor: ${undeclared.length} undeclared difference(s)`)
      process.exitCode = 1
    }
  } finally {
    await Promise.all(opened.map((o) => o.pool.end()))
  }
}
/* eslint-enable no-console */

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
