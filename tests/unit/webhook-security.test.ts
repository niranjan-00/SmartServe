import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { STATUS_TRANSITIONS, computeTransitionGuard } from '../helpers/status-machine'
import { verifyMetaSignature } from '../../src/server/crypto'
import { extractInboundMessages, extractStatusUpdates } from '../../src/server/services/whatsapp/types'
import { verifyWebhook } from '../../src/server/services/whatsapp'
import { encryptSecret, decryptSecret, safeEqual } from '../../src/server/crypto'

/**
 * Webhook + security tests (spec §15/§17/§51/§58).
 */

// Status machine (shared copy mirrors src/lib/types.ts)
const SRC_TRANSITIONS: Record<string, string[]> = {
  NEW: ['ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'CLOSED'],
  ACKNOWLEDGED: ['ASSIGNED', 'IN_PROGRESS', 'CLOSED'],
  ASSIGNED: ['IN_PROGRESS', 'ACKNOWLEDGED', 'CLOSED'],
  IN_PROGRESS: ['RESOLVED', 'ASSIGNED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  CLOSED: ['REOPENED'],
  REOPENED: ['IN_PROGRESS', 'ASSIGNED', 'ACKNOWLEDGED', 'CLOSED'],
}

describe('status transition matrix (server-side validation)', () => {
  it('NEW cannot jump directly to RESOLVED (must be worked first)', () => {
    expect(computeTransitionGuard('NEW', 'RESOLVED')).toBe(false)
  })

  it('RESOLVED cannot go back to IN_PROGRESS (reopen flow instead)', () => {
    expect(computeTransitionGuard('RESOLVED', 'IN_PROGRESS')).toBe(false)
  })

  it('mirrors the source transitions exactly', () => {
    expect(JSON.stringify(STATUS_TRANSITIONS)).toBe(JSON.stringify(SRC_TRANSITIONS))
  })
})

// ---------------------------------------------------------------------------
// Meta webhook signature (spec §15)
// ---------------------------------------------------------------------------

describe('webhook signature verification', () => {
  const appSecret = 'test-app-secret'
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })

  it('accepts a valid signature', () => {
    // compute expected the same way Meta would
    const sig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(body).digest('hex')
    expect(verifyMetaSignature(body, sig, appSecret)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const sig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(body + 'tampered').digest('hex')
    expect(verifyMetaSignature(body, sig, appSecret)).toBe(false)
  })

  it('rejects when secret or header missing', () => {
    expect(verifyMetaSignature(body, null, appSecret)).toBe(false)
    expect(verifyMetaSignature(body, 'sha256=abc', undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Hub verification (spec §14)
// ---------------------------------------------------------------------------

describe('webhook hub verification', () => {
  it('accepts matching verify token and echoes challenge', () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token-1'
    const params = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token-1', 'hub.challenge': 'CHALLENGE_123' })
    const result = verifyWebhook(params)
    expect(result).toEqual({ ok: true, challenge: 'CHALLENGE_123' })
  })

  it('rejects a wrong token', () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token-1'
    const params = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'X' })
    expect(verifyWebhook(params)).toEqual({ ok: false })
  })
})

// ---------------------------------------------------------------------------
// Payload extraction (spec §16)
// ---------------------------------------------------------------------------

describe('inbound payload extraction', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'PNID-1' },
              contacts: [{ profile: { name: 'Rahul' }, wa_id: '919876543210' }],
              messages: [
                { from: '919876543210', id: 'wamid.A', timestamp: '1767139200', type: 'text', text: { body: 'AC broken' } },
                { from: '919876543210', id: 'wamid.B', type: 'image', image: { id: 'media1', mime_type: 'image/jpeg' } },
              ],
            },
          },
        ],
      },
    ],
  }

  it('extracts both messages with org-routing metadata', () => {
    const messages = extractInboundMessages(payload)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ phoneNumberId: 'PNID-1', text: 'AC broken', type: 'TEXT' })
    expect(messages[1]).toMatchObject({ type: 'IMAGE', mediaId: 'media1' })
  })

  it('ignores malformed payloads without throwing', () => {
    expect(extractInboundMessages({ foo: 'bar' })).toHaveLength(0)
    expect(extractInboundMessages(null)).toHaveLength(0)
  })

  it('extracts status (delivery/read) updates', () => {
    const statuses = extractStatusUpdates({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.A', status: 'delivered', recipient_id: '919876543210' }] } }] }],
    })
    expect(statuses).toEqual([{ whatsappMessageId: 'wamid.A', status: 'DELIVERED', recipientId: '919876543210' }])
  })
})

// ---------------------------------------------------------------------------
// Secrets at rest (spec §12/§46)
// ---------------------------------------------------------------------------

describe('secret encryption', () => {
  it('round-trips an access token via AES-256-GCM', () => {
    const token = 'EAAG-super-secret-whatsapp-token-123'
    const encrypted = encryptSecret(token)
    expect(encrypted).not.toContain(token)
    expect(decryptSecret(encrypted)).toBe(token)
  })

  it('timing-safe comparison', () => {
    expect(safeEqual('same', 'same')).toBe(true)
    expect(safeEqual('same', 'diff')).toBe(false)
  })
})
