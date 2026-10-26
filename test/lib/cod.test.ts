import { describe, expect, it } from 'vitest'

import {
  COD_CONFIG_DEFAULTS,
  codSplit,
  evaluateCod,
  evaluateCodBeforeDestination,
  type CodConfig,
} from '../../src/lib/cod.js'

const ON: CodConfig = { ...COD_CONFIG_DEFAULTS, enabled: true }

const evaluate = (over: Partial<Parameters<typeof evaluateCod>[0]> = {}) =>
  evaluateCod({
    config: ON,
    cartTotalInr: 700,
    destPincode: '380001',
    codOrdersThisMonth: 0,
    ...over,
  })

describe('evaluateCod', () => {
  it('splits the total — the token is part of it, never on top', () => {
    const result = evaluate()
    expect(result).toEqual({
      available: true,
      tokenInr: 49,
      dueOnDeliveryInr: 651,
      reason: null,
    })
    expect(result.tokenInr + result.dueOnDeliveryInr).toBe(700)
  })

  it('is off by default — no configuration mistake can turn COD on', () => {
    expect(evaluate({ config: COD_CONFIG_DEFAULTS }).reason).toBe('disabled')
  })

  it('refuses before it knows where the parcel is going', () => {
    expect(evaluate({ destPincode: '' }).reason).toBe('no_destination')
  })

  it('reports disabled ahead of every other reason', () => {
    // The order of the gates is load-bearing: a switched-off feature must not
    // depend on the pincode list having loaded correctly.
    expect(
      evaluate({
        config: { ...COD_CONFIG_DEFAULTS, pincodes: { mode: 'allow', list: [] } },
        destPincode: '',
        cartTotalInr: 10,
      }).reason
    ).toBe('disabled')
  })

  describe('pincode policy', () => {
    it('allow-lists exactly, with no prefix matching', () => {
      const config: CodConfig = { ...ON, pincodes: { mode: 'allow', list: ['380001'] } }
      expect(evaluate({ config }).available).toBe(true)
      expect(evaluate({ config, destPincode: '380009' }).reason).toBe('pincode_not_allowed')
    })

    it('block-lists', () => {
      const config: CodConfig = { ...ON, pincodes: { mode: 'block', list: ['380001'] } }
      expect(evaluate({ config }).reason).toBe('pincode_not_allowed')
      expect(evaluate({ config, destPincode: '380009' }).available).toBe(true)
    })
  })

  describe('limits', () => {
    it('stops at the monthly cap', () => {
      expect(evaluate({ codOrdersThisMonth: 100 }).reason).toBe('cap_reached')
      expect(evaluate({ codOrdersThisMonth: 99 }).available).toBe(true)
    })

    it('honours the cart floor and ceiling', () => {
      expect(evaluate({ config: { ...ON, minCartInr: 800 } }).reason).toBe('cart_below_min')
      expect(evaluate({ cartTotalInr: 2001 }).reason).toBe('cart_above_max')
      expect(evaluate({ cartTotalInr: 2000 }).available).toBe(true)
    })

    it('refuses a cart the token would swallow', () => {
      // At exactly the token the balance is ₹0, which the
      // `payments_cod_mode_consistent` CHECK rejects at insert. Refusing here
      // means the shopper is never offered something the database will not take.
      expect(evaluate({ cartTotalInr: 49 }).reason).toBe('cart_below_token')
      expect(evaluate({ cartTotalInr: 50 })).toMatchObject({
        available: true,
        dueOnDeliveryInr: 1,
      })
    })
  })

  it('reports zero money on every refusal', () => {
    const refused = evaluate({ config: COD_CONFIG_DEFAULTS })
    expect(refused.tokenInr).toBe(0)
    expect(refused.dueOnDeliveryInr).toBe(0)
  })
})

describe('codSplit', () => {
  it('derives the balance from the total so the two can never disagree', () => {
    expect(codSplit(70000, 49)).toEqual({ prepaidAmountPaise: 4900, codAmountPaise: 65100 })
  })
})

describe('evaluateCodBeforeDestination', () => {
  it('returns the live split while leaving the pincode decision to the caller', () => {
    expect(
      evaluateCodBeforeDestination({
        config: { ...ON, pincodes: { mode: 'allow', list: [] } },
        cartTotalInr: 700,
        codOrdersThisMonth: 1,
      })
    ).toEqual({ available: true, tokenInr: 49, dueOnDeliveryInr: 651, reason: null })
  })

  it('still enforces the switch, monthly cap, amount ceiling, and token rule', () => {
    expect(
      evaluateCodBeforeDestination({
        config: COD_CONFIG_DEFAULTS,
        cartTotalInr: 700,
        codOrdersThisMonth: 0,
      }).reason
    ).toBe('disabled')
    expect(
      evaluateCodBeforeDestination({
        config: ON,
        cartTotalInr: 700,
        codOrdersThisMonth: 100,
      }).reason
    ).toBe('cap_reached')
    expect(
      evaluateCodBeforeDestination({
        config: ON,
        cartTotalInr: 2001,
        codOrdersThisMonth: 0,
      }).reason
    ).toBe('cart_above_max')
    expect(
      evaluateCodBeforeDestination({
        config: ON,
        cartTotalInr: 49,
        codOrdersThisMonth: 0,
      }).reason
    ).toBe('cart_below_token')
  })
})
