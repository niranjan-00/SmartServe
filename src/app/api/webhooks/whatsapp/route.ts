
import { createHmac, timingSafeEqual } from 'node:crypto'

import { jsonOk } from '@/server/api'
import { db } from '@/lib/db'
import {
  verifyWebhook,
  processWebhookPayload,
  verifyWebhookSignature,
} from '@/server/services/whatsapp'
import { rateLimit, clientIp } from '@/server/rate-limit'
import { createLogger } from '@/server/logger'
import { ApiError, jsonError } from '@/server/errors'

const log = createLogger('webhook')

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const result = verifyWebhook(url.searchParams)

  if (result.ok) {
    log.info('webhook.verified', { ip: clientIp(req) })
    return new Response(result.challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  log.warn('webhook.verification_rejected', { ip: clientIp(req) })
  return new Response('Forbidden', { status: 403 })
}

function verifyWahaWebhook(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.WAHA_WEBHOOK_SECRET?.trim()

  if (!secret) return process.env.NODE_ENV !== 'production'
  if (!signatureHeader) return false

  try {
    const supplied = signatureHeader.trim().replace(/^sha512=/i, '')
    if (!/^[a-f0-9]{128}$/i.test(supplied)) return false

    const expected = createHmac('sha512', secret)
      .update(rawBody, 'utf8')
      .digest()

    const received = Buffer.from(supplied, 'hex')

    return (
      received.length === expected.length &&
      timingSafeEqual(received, expected)
    )
  } catch {
    return false
  }
}

function parseWahaTimestamp(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value > 1e12 ? value : value * 1000)
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)

    if (Number.isFinite(numeric)) {
      const parsed = new Date(numeric > 1e12 ? numeric : numeric * 1000)
      return Number.isNaN(parsed.getTime()) ? new Date() : parsed
    }

    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed
  }

  return new Date()
}

function getWahaMessageId(message: UnknownRecord): string | null {
  const id = message.id

  if (typeof id === 'string' && id.trim()) return id.trim()

  if (isRecord(id)) {
    return stringValue(id._serialized) ?? stringValue(id.id)
  }

  return null
}

function getWahaSender(message: UnknownRecord): string | null {
  const from = stringValue(message.from)
  if (!from) return null

  return (
    from
      .replace(/@c\.us$/i, '')
      .replace(/@s\.whatsapp\.net$/i, '')
      .trim() || null
  )
}

async function findWahaConnection(sessionName: string) {
  return db.whatsAppConnection.findUnique({
    where: { wahaSessionName: sessionName },
  })
}

async function handleWahaSessionStatus(
  payload: UnknownRecord,
): Promise<Response> {
  const session = stringValue(payload.session)

  if (!session) {
    return jsonOk({
      accepted: false,
      processed: 0,
      reason: 'Missing WAHA session name',
    })
  }

  const connection = await findWahaConnection(session)

  if (!connection) {
    log.warn('waha.webhook.unknown_session', { session })

    return jsonOk({
      accepted: false,
      processed: 0,
      reason: 'No WAHA connection configured for this session',
    })
  }

  const eventPayload = isRecord(payload.payload) ? payload.payload : {}
  const nestedStatus = isRecord(eventPayload.status)
    ? eventPayload.status.status
    : eventPayload.status

  const status = String(nestedStatus ?? 'UNKNOWN').toUpperCase()

  const mappedStatus =
    status === 'WORKING'
      ? 'CONNECTED'
      : status === 'FAILED'
        ? 'ERROR'
        : 'CONNECTING'

  const me = isRecord(eventPayload.me) ? eventPayload.me : {}
  const meId = stringValue(me.id)

  await db.whatsAppConnection.update({
    where: { id: connection.id },
    data: {
      status: mappedStatus,
      statusMessage: `waha-adapter: ${status}`,
      ...(meId ? { displayPhoneNumber: meId.split('@')[0] } : {}),
      ...(status === 'WORKING' ? { lastVerifiedAt: new Date() } : {}),
    },
  })

  return jsonOk({
    accepted: true,
    processed: 1,
    event: 'session.status',
  })
}

async function handleWahaMessage(
  payload: UnknownRecord,
): Promise<Response> {
  const message = isRecord(payload.payload) ? payload.payload : {}

  if (message.fromMe === true) {
    return jsonOk({
      accepted: true,
      processed: 0,
      reason: 'outgoing message ignored',
    })
  }

  const session = stringValue(payload.session)

  if (!session) {
    return jsonOk({
      accepted: false,
      processed: 0,
      reason: 'Missing WAHA session name',
    })
  }

  const connection = await findWahaConnection(session)

  if (!connection) {
    log.warn('waha.webhook.no_connection', { session })

    return jsonOk({
      accepted: false,
      processed: 0,
      reason: 'No WAHA connection configured',
    })
  }

  const sender = getWahaSender(message)
  const messageId = getWahaMessageId(message)

  if (!sender || !messageId) {
    log.warn('waha.webhook.invalid_message', { session })

    return jsonOk({
      accepted: false,
      processed: 0,
      reason: 'Missing sender or message ID',
    })
  }

  const rawType = stringValue(message.type) ?? 'chat'
  const messageType = rawType.toLowerCase()
  const body = typeof message.body === 'string' ? message.body : undefined
  const timestamp = parseWahaTimestamp(message.timestamp)

  const data = isRecord(message._data) ? message._data : {}
  const profileName =
    stringValue(data.notifyName) ??
    stringValue(message.notifyName) ??
    sender

  const normalizedPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: connection.wabaId || 'waha',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: {
                phone_number_id: connection.phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: profileName },
                  wa_id: sender,
                },
              ],
              messages: [
                {
                  id: messageId,
                  from: sender,
                  timestamp: String(
                    Math.floor(timestamp.getTime() / 1000),
                  ),
                  type: messageType === 'chat' ? 'text' : messageType,
                  ...(body
                    ? { text: { body } }
                    : messageType !== 'chat'
                      ? {
                          [messageType]: {
                            id: messageId,
                            mime_type: stringValue(message.mimetype),
                          },
                        }
                      : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  }

  const result = await processWebhookPayload({
    rawBody: JSON.stringify(normalizedPayload),
    signatureHeader: null,
    payload: normalizedPayload,
  })

  log.info('waha.webhook.processed', {
    session,
    messageId,
    accepted: result.accepted,
    processed: result.processed,
    reason: result.reason,
  })

  return jsonOk(result)
}

export async function POST(req: Request): Promise<Response> {
  try {
    rateLimit(`whwebhook:${clientIp(req)}`, 600, 60_000)

    const rawBody = await req.text()

    if (!rawBody || rawBody.length > 2_000_000) {
      throw ApiError.badRequest(
        'Webhook body is empty or exceeds the 2 MB limit',
      )
    }

    let payload: unknown

    try {
      payload = JSON.parse(rawBody)
    } catch {
      throw ApiError.badRequest('Body must be valid JSON')
    }

    if (!isRecord(payload)) {
      throw ApiError.badRequest('Webhook payload must be a JSON object')
    }

    // META WHATSAPP CLOUD API
    if (payload.object === 'whatsapp_business_account') {
      const signature = req.headers.get('x-hub-signature-256')
      const appSecret = process.env.WHATSAPP_APP_SECRET?.trim()

      if (!appSecret && process.env.NODE_ENV === 'production') {
        log.error('webhook.meta_secret_missing')

        return Response.json(
          {
            accepted: false,
            error: 'Webhook signature verification is not configured',
          },
          { status: 503 },
        )
      }

      if (
        appSecret &&
        !verifyWebhookSignature(rawBody, signature, appSecret)
      ) {
        log.warn('webhook.signature_invalid', { ip: clientIp(req) })

        throw new ApiError(
          401,
          'INVALID_SIGNATURE',
          'Signature verification failed',
        )
      }

      const result = await processWebhookPayload({
        rawBody,
        signatureHeader: signature,
        payload,
      })

      if (!result.accepted) {
        log.info('webhook.ignored', { reason: result.reason })
      }

      return jsonOk(result)
    }

    // WAHA
    const event = stringValue(payload.event)

    if (event) {
      if (
        !verifyWahaWebhook(
          rawBody,
          req.headers.get('x-webhook-hmac'),
        )
      ) {
        log.warn('waha.webhook.signature_invalid', {
          ip: clientIp(req),
        })

        throw new ApiError(
          401,
          'INVALID_WAHA_SIGNATURE',
          'WAHA webhook signature verification failed.',
        )
      }

      if (event === 'session.status') {
        return await handleWahaSessionStatus(payload)
      }

      if (event === 'message') {
        return await handleWahaMessage(payload)
      }

      log.info('waha.webhook.ignored', { event })

      return jsonOk({
        accepted: true,
        processed: 0,
        reason: `Unsupported WAHA event: ${event}`,
      })
    }

    return jsonOk({
      accepted: false,
      processed: 0,
      reason: 'No recognized events',
    })
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonError(error)
    }

    log.error('webhook.processing_failed', {
      message: errorMessage(error),
      ip: clientIp(req),
    })

    // Return 5xx for processing failures so WhatsApp can retry.
    return Response.json(
      {
        accepted: false,
        processed: 0,
        error: 'Webhook processing failed',
      },
      { status: 500 },
    )
  }
}
