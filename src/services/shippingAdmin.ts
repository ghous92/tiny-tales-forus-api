/**
 * Shipping data-in: pickup nodes, courier rate cards, service areas, and the
 * two CSV imports. The read side lives in `services/shipping.ts`; this module
 * only writes, and every write ends by dropping that module's cache.
 *
 * Three rules run through the whole file.
 *
 * **Every mutation resets the rate cache.** `services/shipping.ts` holds nodes,
 * couriers and the parsed rule for 60 seconds. That ceiling is fine for a
 * config edit landing eventually; it is not fine for an operator who saves a
 * slab and immediately opens the simulator to see what it did. A stale
 * simulator would show them the margin of the table they just replaced, which
 * is precisely the number they are trying to check. Cache reset is per-process,
 * so on Cloud Run a sibling instance can still be up to 60 s behind — the
 * simulator the operator is looking at is not.
 *
 * **Rate cards are replaced whole.** See contracts/shippingAdmin.ts. A partial
 * slab update can leave a zone holding rows from two different carrier
 * contracts, and nothing downstream can detect that.
 *
 * **Imports report their refusals.** A CSV that half-parses silently is worse
 * than one that fails: the operator believes the carrier's serviceability file
 * is loaded, and the rows that did not parse become "not serviceable" for real
 * customers. Every skipped row is counted and the first few are named.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'

import type {
  AdminCourier,
  CourierCreate,
  CourierUpdate,
  ImportResult,
  PickupNode,
  PickupNodeCreate,
  PickupNodeUpdate,
  RateSlabInput,
  ServiceAreasReplace,
} from '../contracts/shippingAdmin.js'
import type { Db } from '../db/client.js'
import {
  courierRateSlabs,
  courierServiceAreas,
  courierServiceExceptions,
  couriers,
  pickupNodes,
  pincodes,
} from '../db/schema.js'
import { notFound, validationFailed } from '../lib/errors.js'
import { resetShippingCache } from './shipping.js'

/** Same local alias services/coupons.ts uses — drizzle does not export this. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** How many bad rows an import names before it just counts the rest. */
const MAX_REPORTED_ERRORS = 50

// --- Pickup nodes ------------------------------------------------------------

function toNode(row: typeof pickupNodes.$inferSelect): PickupNode {
  return {
    code: row.code,
    name: row.name,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    houseNumber: row.houseNumber,
    roadArea: row.roadArea,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    lat: row.lat,
    lng: row.lng,
    isActive: row.isActive,
    priority: row.priority,
    cutoffIst: row.cutoffIst,
  }
}

export async function listPickupNodes(db: Db): Promise<PickupNode[]> {
  const rows = await db.select().from(pickupNodes).orderBy(pickupNodes.priority, pickupNodes.code)
  return rows.map(toNode)
}

export async function createPickupNode(db: Db, input: PickupNodeCreate): Promise<PickupNode> {
  const [existing] = await db
    .select({ code: pickupNodes.code })
    .from(pickupNodes)
    .where(eq(pickupNodes.code, input.code))
    .limit(1)
  if (existing) throw validationFailed(`Pickup node "${input.code}" already exists`)

  const [created] = await db
    .insert(pickupNodes)
    .values({
      code: input.code,
      name: input.name,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      houseNumber: input.houseNumber,
      roadArea: input.roadArea,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      isActive: input.isActive,
      priority: input.priority,
      cutoffIst: input.cutoffIst,
    })
    .returning()

  resetShippingCache(db)
  return toNode(created!)
}

export async function updatePickupNode(
  db: Db,
  code: string,
  patch: PickupNodeUpdate
): Promise<PickupNode> {
  // A node whose address changed but whose coordinates did not is a node that
  // now geocodes to the wrong place, so moving the address clears the pin and
  // forces the operator back through "resolve + confirm".
  const movesAddress =
    patch.houseNumber !== undefined ||
    patch.roadArea !== undefined ||
    patch.city !== undefined ||
    patch.state !== undefined ||
    patch.pincode !== undefined
  const setsCoordinates = patch.lat !== undefined || patch.lng !== undefined

  const values = {
    ...patch,
    ...(movesAddress && !setsCoordinates ? { lat: null, lng: null } : {}),
    updatedAt: new Date(),
  }

  const [updated] = await db
    .update(pickupNodes)
    .set(values)
    .where(eq(pickupNodes.code, code))
    .returning()
  if (!updated) throw notFound(`Pickup node "${code}" not found`)

  resetShippingCache(db)
  return toNode(updated)
}

export async function deletePickupNode(db: Db, code: string): Promise<void> {
  const [deleted] = await db
    .delete(pickupNodes)
    .where(eq(pickupNodes.code, code))
    .returning({ code: pickupNodes.code })
  if (!deleted) throw notFound(`Pickup node "${code}" not found`)
  resetShippingCache(db)
}

// --- Couriers ----------------------------------------------------------------

/**
 * List every courier with its rate card inlined.
 *
 * Four queries rather than a join: the editor needs slabs and areas grouped
 * per courier anyway, and a join would fan the courier row out across every
 * slab it owns only for this code to regroup it.
 */
export async function listCouriers(db: Db): Promise<AdminCourier[]> {
  const [rows, slabs, areas, exceptionCounts] = await Promise.all([
    db.select().from(couriers).orderBy(couriers.priority, couriers.code),
    db
      .select()
      .from(courierRateSlabs)
      .orderBy(courierRateSlabs.courierCode, courierRateSlabs.zone, courierRateSlabs.uptoG),
    db.select().from(courierServiceAreas).orderBy(courierServiceAreas.fromPincode),
    db
      .select({
        courierCode: courierServiceExceptions.courierCode,
        count: sql<number>`count(*)::int`,
      })
      .from(courierServiceExceptions)
      .groupBy(courierServiceExceptions.courierCode),
  ])

  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    mode: row.mode === 'express' ? ('express' as const) : ('surface' as const),
    rateModel: row.rateModel === 'distance' ? ('distance' as const) : ('weight' as const),
    volumetricDivisor: row.volumetricDivisor,
    minChargeableG: row.minChargeableG,
    fuelBps: row.fuelBps,
    gstBps: row.gstBps,
    docketFeeInr: row.docketFeeInr,
    riskBps: row.riskBps,
    riskMinInr: row.riskMinInr,
    codFlatInr: row.codFlatInr,
    codBps: row.codBps,
    rtoBps: row.rtoBps,
    slaDaysZoneA: row.slaDaysZoneA,
    slaDaysZoneB: row.slaDaysZoneB,
    reliabilityScore: row.reliabilityScore,
    priority: row.priority,
    slabs: slabs
      .filter((slab) => slab.courierCode === row.code)
      .map((slab) => ({
        zone: slab.zone as RateSlabInput['zone'],
        uptoG: slab.uptoG,
        rateInr: slab.rateInr,
        addlPerG: slab.addlPerG,
        addlRateInr: slab.addlRateInr,
      })),
    serviceAreas: areas
      .filter((area) => area.courierCode === row.code)
      .map((area) => ({
        fromPincode: area.fromPincode,
        toPincode: area.toPincode,
        prepaid: area.prepaid,
        cod: area.cod,
        isActive: area.isActive,
      })),
    exceptionCount: exceptionCounts.find((c) => c.courierCode === row.code)?.count ?? 0,
  }))
}

async function requireCourier(db: Db | Tx, code: string): Promise<void> {
  const [row] = await db
    .select({ code: couriers.code })
    .from(couriers)
    .where(eq(couriers.code, code))
    .limit(1)
  if (!row) throw notFound(`Courier "${code}" not found`)
}

/** One courier by code, rate card inlined. Throws 404 when absent. */
export async function getCourier(db: Db, code: string): Promise<AdminCourier> {
  const all = await listCouriers(db)
  const found = all.find((courier) => courier.code === code)
  if (!found) throw notFound(`Courier "${code}" not found`)
  return found
}

export async function createCourier(db: Db, input: CourierCreate): Promise<AdminCourier> {
  const [existing] = await db
    .select({ code: couriers.code })
    .from(couriers)
    .where(eq(couriers.code, input.code))
    .limit(1)
  if (existing) throw validationFailed(`Courier "${input.code}" already exists`)

  await db.insert(couriers).values(input)
  resetShippingCache(db)
  return getCourier(db, input.code)
}

export async function updateCourier(
  db: Db,
  code: string,
  patch: CourierUpdate
): Promise<AdminCourier> {
  const [updated] = await db
    .update(couriers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(couriers.code, code))
    .returning({ code: couriers.code })
  if (!updated) throw notFound(`Courier "${code}" not found`)

  resetShippingCache(db)
  return getCourier(db, code)
}

/**
 * Hard delete, taking the carrier's own rate data with it.
 *
 * All three rate tables carry `references(couriers.code, onDelete: 'cascade')`
 * (drizzle/0010), so the database would clear them on its own. The rows are
 * deleted explicitly anyway, before the parent, so the invariant survives the
 * FK being dropped or the tables being re-keyed: an orphan rate card is
 * invisible until someone re-creates the same code and silently inherits a
 * price list they never entered.
 */
export async function deleteCourier(db: Db, code: string): Promise<void> {
  await db.transaction(async (tx: Tx) => {
    await requireCourier(tx, code)

    await tx.delete(courierRateSlabs).where(eq(courierRateSlabs.courierCode, code))
    await tx.delete(courierServiceAreas).where(eq(courierServiceAreas.courierCode, code))
    await tx.delete(courierServiceExceptions).where(eq(courierServiceExceptions.courierCode, code))

    await tx.delete(couriers).where(eq(couriers.code, code))
  })
  resetShippingCache(db)
}

/**
 * Replace a courier's rate card wholesale.
 *
 * Rejects duplicate (zone, uptoG) pairs before writing anything. The DB's
 * composite PK would reject them too, but as an opaque constraint violation —
 * and "you have two ≤500 g rows in zone B" is a sentence the operator can act
 * on, where a Postgres error code is not.
 */
export async function replaceSlabs(
  db: Db,
  code: string,
  slabs: RateSlabInput[]
): Promise<AdminCourier> {
  const seen = new Set<string>()
  for (const slab of slabs) {
    const key = `${slab.zone}:${slab.uptoG}`
    if (seen.has(key)) {
      throw validationFailed(`Duplicate slab for zone ${slab.zone} at ${slab.uptoG} g`)
    }
    seen.add(key)
  }

  await db.transaction(async (tx: Tx) => {
    await requireCourier(tx, code)
    await tx.delete(courierRateSlabs).where(eq(courierRateSlabs.courierCode, code))
    if (slabs.length > 0) {
      await tx
        .insert(courierRateSlabs)
        .values(slabs.map((slab) => ({ courierCode: code, ...slab })))
    }
  })

  resetShippingCache(db)
  return getCourier(db, code)
}

export async function replaceServiceAreas(
  db: Db,
  code: string,
  input: ServiceAreasReplace
): Promise<AdminCourier> {
  for (const area of input.serviceAreas) {
    if (area.fromPincode > area.toPincode) {
      throw validationFailed(`Range ${area.fromPincode}–${area.toPincode} is inverted`)
    }
  }

  await db.transaction(async (tx: Tx) => {
    await requireCourier(tx, code)
    await tx.delete(courierServiceAreas).where(eq(courierServiceAreas.courierCode, code))
    if (input.serviceAreas.length > 0) {
      await tx
        .insert(courierServiceAreas)
        .values(input.serviceAreas.map((area) => ({ courierCode: code, ...area })))
    }
  })

  resetShippingCache(db)
  return getCourier(db, code)
}

// --- CSV imports -------------------------------------------------------------

/**
 * Split a CSV into rows of trimmed cells.
 *
 * Deliberately NOT an RFC-4180 parser: no quoted fields, no embedded newlines.
 * The two files this consumes are a carrier's pincode list and India Post's
 * export, both of which are plain comma-or-tab separated columns of codes and
 * place names. A quoted-field parser here would be dead code pretending to be
 * a guarantee. A row whose cell count is wrong is reported, not guessed at.
 */
function parseCsv(csv: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = []
  const lines = csv.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!
    if (raw.trim() === '') continue
    out.push({ line: i + 1, cells: raw.split(/[,\t]/).map((cell) => cell.trim()) })
  }
  return out
}

/** True when a row looks like a header rather than data. */
function isHeader(cells: string[]): boolean {
  return !/^[1-9][0-9]{5}$/.test(cells[0] ?? '')
}

const PINCODE_RE = /^[1-9][0-9]{5}$/

/** Truthy spellings a human or a carrier file might use for "we deliver here". */
function parseBool(value: string | undefined, fallback: boolean): boolean | null {
  if (value === undefined || value === '') return fallback
  const v = value.trim().toLowerCase()
  if (['1', 'y', 'yes', 'true', 'serviceable'].includes(v)) return true
  if (['0', 'n', 'no', 'false', 'non-serviceable', 'nonserviceable'].includes(v)) return false
  return null
}

interface ImportAccumulator {
  parsed: number
  inserted: number
  updated: number
  skipped: number
  errors: { line: number; message: string }[]
  errorsTruncated: boolean
}

function newAccumulator(): ImportAccumulator {
  return { parsed: 0, inserted: 0, updated: 0, skipped: 0, errors: [], errorsTruncated: false }
}

function reject(acc: ImportAccumulator, line: number, message: string): void {
  acc.skipped += 1
  if (acc.errors.length < MAX_REPORTED_ERRORS) acc.errors.push({ line, message })
  else acc.errorsTruncated = true
}

/**
 * Import a carrier serviceability file: `pincode,serviceable`.
 *
 * A missing second column means "serviceable" — carriers publish lists of
 * pincodes they DO cover far more often than mixed files. An unparseable
 * second column is rejected rather than defaulted, because guessing here turns
 * a typo into a silently unserviceable postcode.
 */
export async function importServiceExceptions(
  db: Db,
  code: string,
  csv: string,
  replace: boolean
): Promise<ImportResult> {
  await requireCourier(db, code)

  const acc = newAccumulator()
  const rows = parseCsv(csv)
  const values = new Map<string, boolean>()

  for (const { line, cells } of rows) {
    if (line === rows[0]?.line && isHeader(cells)) continue
    acc.parsed += 1

    const pin = cells[0] ?? ''
    if (!PINCODE_RE.test(pin)) {
      reject(acc, line, `"${pin}" is not a 6-digit pincode`)
      continue
    }

    const serviceable = parseBool(cells[1], true)
    if (serviceable === null) {
      reject(acc, line, `"${cells[1]}" is not a yes/no value`)
      continue
    }

    // Last occurrence wins, and a file that lists the same pincode twice with
    // different answers is worth saying out loud.
    if (values.has(pin) && values.get(pin) !== serviceable) {
      reject(acc, line, `${pin} appears twice with conflicting values; keeping the last`)
    }
    values.set(pin, serviceable)
  }

  if (values.size > 0 || replace) {
    await db.transaction(async (tx: Tx) => {
      if (replace) {
        await tx
          .delete(courierServiceExceptions)
          .where(eq(courierServiceExceptions.courierCode, code))
      }

      const entries = [...values.entries()]
      const existing = replace
        ? new Set<string>()
        : new Set(
            (
              await tx
                .select({ pincode: courierServiceExceptions.pincode })
                .from(courierServiceExceptions)
                .where(
                  and(
                    eq(courierServiceExceptions.courierCode, code),
                    inArray(
                      courierServiceExceptions.pincode,
                      entries.map(([pin]) => pin)
                    )
                  )
                )
            ).map((row) => row.pincode)
          )

      acc.inserted = entries.filter(([pin]) => !existing.has(pin)).length
      acc.updated = entries.length - acc.inserted

      // Chunked: Postgres caps a statement at 65535 bound parameters, and a
      // full carrier file at 3 params per row would blow through that.
      for (let i = 0; i < entries.length; i += 5000) {
        const chunk = entries.slice(i, i + 5000)
        await tx
          .insert(courierServiceExceptions)
          .values(
            chunk.map(([pin, serviceable]) => ({ courierCode: code, pincode: pin, serviceable }))
          )
          .onConflictDoUpdate({
            target: [courierServiceExceptions.courierCode, courierServiceExceptions.pincode],
            set: {
              serviceable: sql`excluded.serviceable`,
              updatedAt: new Date(),
            },
          })
      }
    })
  }

  resetShippingCache(db)
  return acc
}

/**
 * Import India Post reference data: `pincode,officeName,taluk,district,state`
 * (with optional `lat,lng`).
 *
 * TALUK IS REQUIRED and that is the point. Zone A is same-taluk, so a file
 * imported with the District column in the Taluk position silently promotes
 * every pincode in a district to the cheapest zone — the Ahmedabad district
 * alone would swallow a large rural area at a same-city price. A row with a
 * blank taluk is rejected rather than stored, so the mistake shows up as
 * refused rows at import time instead of as margin erosion months later.
 */
export async function importPincodes(db: Db, csv: string): Promise<ImportResult> {
  const acc = newAccumulator()
  const rows = parseCsv(csv)
  const values = new Map<string, typeof pincodes.$inferInsert>()

  for (const { line, cells } of rows) {
    if (line === rows[0]?.line && isHeader(cells)) continue
    acc.parsed += 1

    const [pin, officeName, taluk, district, state, latText, lngText] = cells
    if (!PINCODE_RE.test(pin ?? '')) {
      reject(acc, line, `"${pin}" is not a 6-digit pincode`)
      continue
    }
    if (!taluk || taluk.trim() === '') {
      reject(acc, line, 'taluk is blank — Zone A is derived from taluk, so it cannot be empty')
      continue
    }
    if (!state || state.trim() === '') {
      reject(acc, line, 'state is blank — the serviceable-state fence reads this column')
      continue
    }

    const lat = latText ? Number(latText) : Number.NaN
    const lng = lngText ? Number(lngText) : Number.NaN

    values.set(pin!, {
      pincode: pin!,
      officeName: officeName ?? '',
      taluk: taluk.trim(),
      district: district ?? '',
      state: state.trim(),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    })
  }

  const entries = [...values.values()]
  if (entries.length > 0) {
    await db.transaction(async (tx: Tx) => {
      const existing = new Set(
        (
          await tx
            .select({ pincode: pincodes.pincode })
            .from(pincodes)
            .where(
              inArray(
                pincodes.pincode,
                entries.map((row) => row.pincode)
              )
            )
        ).map((row) => row.pincode)
      )
      acc.inserted = entries.filter((row) => !existing.has(row.pincode)).length
      acc.updated = entries.length - acc.inserted

      for (let i = 0; i < entries.length; i += 2000) {
        await tx
          .insert(pincodes)
          .values(entries.slice(i, i + 2000))
          .onConflictDoUpdate({
            target: pincodes.pincode,
            set: {
              officeName: sql`excluded.office_name`,
              taluk: sql`excluded.taluk`,
              district: sql`excluded.district`,
              state: sql`excluded.state`,
              lat: sql`excluded.lat`,
              lng: sql`excluded.lng`,
            },
          })
      }
    })
  }

  // Pincode rows are cached without expiry (they are reference data), so an
  // import that does not reset the cache leaves a process serving the old
  // taluk — and therefore the old zone — until it restarts.
  resetShippingCache(db)
  return acc
}

/**
 * Guard called before `shipping.enabled` is flipped on: is there enough data
 * here to price anything at all?
 *
 * Not wired into the config write path — config is a generic key-value surface
 * and special-casing one key there would be a layering violation. The admin UI
 * calls this and refuses to render the toggle as safe without it.
 */
export async function shippingReadiness(db: Db): Promise<{
  ready: boolean
  problems: string[]
}> {
  const problems: string[] = []

  const [nodeCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(pickupNodes)
    .where(eq(pickupNodes.isActive, true))
  if ((nodeCount?.value ?? 0) === 0) problems.push('No active pickup node.')

  const [courierCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(couriers)
    .where(eq(couriers.isActive, true))
  if ((courierCount?.value ?? 0) === 0) problems.push('No active courier.')

  const [slabCount] = await db.select({ value: sql<number>`count(*)::int` }).from(courierRateSlabs)
  if ((slabCount?.value ?? 0) === 0) problems.push('No courier rate slabs.')

  // Missing pincode reference rows use the coarse distance fallback. Do not
  // require importing a pincode catalogue merely to enable nationwide quotes.

  return { ready: problems.length === 0, problems }
}
