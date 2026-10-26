import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAnalytics, type OrderCompletedInput } from '../../src/lib/analytics.js'

const sdk = vi.hoisted(() => ({ identify: vi.fn(), track: vi.fn(), flush: vi.fn() }))
vi.mock('@rudderstack/rudder-sdk-node', () => ({
  default: class {
    identify = sdk.identify
    track = sdk.track
    flush = sdk.flush
  },
}))

const log = { error: vi.fn(), warn: vi.fn() }
const input: OrderCompletedInput = {
  orderId: 'order-fixture',
  userId: 'user-fixture',
  anonymousId: 'anon-fixture',
  paymentReference: null,
  currency: 'INR',
  total: 440,
  revenue: 349,
  shipping: 91,
  discount: 0,
  products: [{ product_id: 'cream-fixture', sku: 'cream-fixture', price: 349, quantity: 1 }],
  campaign: { source: 'google', medium: 'cpc', name: 'cream-test', content: 'texture' },
}
const configured = () =>
  createAnalytics({
    writeKey: 'fixture',
    dataPlaneUrl: 'https://example.invalid',
    appEnv: 'test',
    log,
  })

beforeEach(() => vi.resetAllMocks())

describe('authoritative commerce analytics', () => {
  it('identifies the saved profile so Mixpanel People receives user properties', () => {
    configured().userProfileUpdated({
      userId: 'user-fixture',
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: '9876543210',
      gender: 'miss',
      dob: '1998-05-20',
      marketingWhatsappOptIn: true,
      adAudienceOptIn: null,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-14T10:00:00.000Z',
    })

    expect(sdk.identify).toHaveBeenCalledWith({
      userId: 'user-fixture',
      traits: {
        name: 'Asha Rao',
        email: 'asha@example.com',
        phone: '9876543210',
        gender: 'miss',
        dob: '1998-05-20',
        marketing_whatsapp_opt_in: true,
        ad_audience_opt_in: null,
        createdAt: '2026-09-01T10:00:00.000Z',
        updated_at: '2026-09-14T10:00:00.000Z',
        app_env: 'test',
      },
      context: { app_env: 'test', active: false },
    })
  })

  it('omits unknown nullable traits instead of overwriting Mixpanel properties with null', () => {
    configured().userProfileUpdated({
      userId: 'user-fixture',
      name: null,
      email: null,
      phone: '9876543210',
      gender: null,
      dob: null,
      marketingWhatsappOptIn: false,
      adAudienceOptIn: null,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-14T10:00:00.000Z',
    })

    expect(sdk.identify.mock.calls[0]![0].traits).not.toHaveProperty('name')
    expect(sdk.identify.mock.calls[0]![0].traits).not.toHaveProperty('email')
    expect(sdk.identify.mock.calls[0]![0].traits).not.toHaveProperty('gender')
    expect(sdk.identify.mock.calls[0]![0].traits).not.toHaveProperty('dob')
  })

  it('preserves identity and order values and exposes frozen attribution to flat funnel filters', () => {
    configured().orderCompleted(input)
    expect(sdk.track).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'Order Completed',
        messageId: 'order-completed:order-fixture',
        userId: 'user-fixture',
        anonymousId: 'anon-fixture',
        properties: expect.objectContaining({
          app_env: 'test',
          funnel_name: 'commerce',
          funnel_version: 2,
          campaign_source: 'google',
          campaign_medium: 'cpc',
          campaign_name: 'cream-test',
          campaign_creative: 'texture',
          event_id: 'order-fixture',
          order_id: 'order-fixture',
          total: 440,
          revenue: 349,
          shipping: 91,
          products: input.products,
        }),
        context: { app_env: 'test', campaign: input.campaign },
      })
    )
    const properties = sdk.track.mock.calls[0]![0].properties
    expect(properties).not.toHaveProperty('platform')
    expect(properties).not.toHaveProperty('campaign_term')
  })

  it('uses the same deduplication keys for retries and distinct keys for different orders', () => {
    const analytics = configured()
    analytics.orderCompleted(input)
    analytics.orderCompleted(input)
    analytics.orderCompleted({ ...input, orderId: 'another-order' })
    const events = sdk.track.mock.calls.map(([event]) => event)
    expect(events[0].messageId).toBe(events[1].messageId)
    expect(events[0].properties.event_id).toBe(events[1].properties.event_id)
    expect(events[2].messageId).not.toBe(events[0].messageId)
    expect(events[2].properties.event_id).not.toBe(events[0].properties.event_id)
  })

  it('does not fabricate anonymous identity or campaign attribution for organic orders', () => {
    configured().orderCompleted({ ...input, anonymousId: null, campaign: null })
    const event = sdk.track.mock.calls[0]![0]
    expect(event).not.toHaveProperty('anonymousId')
    expect(event.context).not.toHaveProperty('campaign')
    expect(event.properties).not.toHaveProperty('campaign_name')
    expect(event.properties.funnel_name).toBe('commerce')
  })

  it('retains content-only campaigns and works for non-cream SKUs', () => {
    configured().orderCompleted({
      ...input,
      campaign: { content: 'hair-video' },
      products: [{ product_id: 'hair-fixture', sku: 'hair-fixture', price: 349, quantity: 1 }],
    })
    const event = sdk.track.mock.calls[0]![0]
    expect(event.context.campaign).toEqual({ content: 'hair-video' })
    expect(event.properties.campaign_creative).toBe('hair-video')
    expect(event.properties.funnel_name).toBe('commerce')
  })

  it('keeps analytics failures out of payment confirmation and shutdown', async () => {
    sdk.track.mockImplementation(() => {
      throw new Error('enqueue failed')
    })
    sdk.flush.mockRejectedValue(new Error('flush failed'))
    const analytics = configured()
    expect(() => analytics.orderCompleted(input)).not.toThrow()
    await expect(analytics.flush()).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('is inert when configuration is absent', async () => {
    const analytics = createAnalytics({ appEnv: 'test', log })
    expect(analytics.enabled).toBe(false)
    analytics.userProfileUpdated({
      userId: 'user-fixture',
      name: null,
      email: null,
      phone: '9876543210',
      gender: null,
      dob: null,
      marketingWhatsappOptIn: false,
      adAudienceOptIn: null,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-14T10:00:00.000Z',
    })
    analytics.orderCompleted(input)
    await analytics.flush()
    expect(sdk.track).not.toHaveBeenCalled()
    expect(sdk.identify).not.toHaveBeenCalled()
  })
})
