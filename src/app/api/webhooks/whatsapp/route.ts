
import { jsonOk } from '@/server/api'
import {
  verifyWebhook,
  processWebhookPayload,
  verifyWebhookSignature,
  getConnection,
} from '@/server/services/whatsapp'
import { rateLimit, clientIp } from '@/server/rate-limit'
import { createLogger } from '@/server/logger'
import { ApiError, jsonError } from '@/server/errors'

const log = createLogger('webhook')

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const result = verifyWebhook(url.searchParams)

  if (result.ok) {
    log.info('webhook.verified', { ip: clientIp(req) })
    return new Response(result.challenge, { status: 200 })
  }

  return new Response('Forbidden', { status: 403 })
}

export async function POST(req: Request): Promise<Response> {
  try {
    rateLimit(`whwebhook:${clientIp(req)}`, 600, 60_000)

    const rawBody = await req.text()

    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch {
      throw ApiError.badRequest('Body must be JSON')
    }

    // Preserve existing Meta WhatsApp webhook handling.
    if (payload?.object === 'whatsapp_business_account') {
      const signature = req.headers.get('x-hub-signature-256')
      const appSecret = process.env.WHATSAPP_APP_SECRET

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
        signatureHeader: req.headers.get('x-hub-signature-256'),
        payload,
      })

      if (!result.accepted) {
        log.info('webhook.ignored', { reason: result.reason })
      }

      return jsonOk(result)
    }

    // Normalize WAHA incoming message events into SmartServe's existing
    // Meta-compatible webhook format.
    if (payload?.event === 'message' && payload?.payload) {
      const message = payload.payload
      const fromMe = message.fromMe === true

      // Only process incoming customer messages.
      if (fromMe) {
        return jsonOk({
          accepted: true,
          processed: 0,
          reason: 'outgoing message ignored',
        })
      }

      const session = payload.session || process.env.WAHA_SESSION || 'default'

      const connection = await findWahaConnection()

      if (!connection) {
        log.warn('waha.webhook.no_connection', { session })
        return jsonOk({
          accepted: false,
          processed: 0,
          reason: 'No WAHA connection configured',
        })
      }

      const chatId =
        typeof message.from === 'string' ? message.from : ''

      const sender = chatId
        .replace(/@c\.us$/i, '')
        .replace(/@s\.whatsapp\.net$/i, '')

      const messageId =
        typeof message.id === 'string'
          ? message.id
          : message.id?._serialized

      if (!sender || !messageId) {
        log.warn('waha.webhook.invalid_message', { session })
        return jsonOk({
          accepted: false,
          processed: 0,
          reason: 'Missing sender or message ID',
        })
      }

      const messageType = message.type || 'chat'
      const body =
        typeof message.body === 'string' ? message.body : undefined

      const timestamp = Number(message.timestamp)
      const messageTimestamp = Number.isFinite(timestamp)
        ? new Date(timestamp > 1e12 ? timestamp : timestamp * 1000)
        : new Date()

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
                      profile: {
                        name:
                          message._data?.notifyName ||
                          message.notifyName ||
                          sender,
                      },
                      wa_id: sender,
                    },
                  ],
                  messages: [
                    {
                      id: messageId,
                      from: sender,
                      timestamp: String(
                        Math.floor(messageTimestamp.getTime() / 1000),
                      ),
                      type: messageType === 'chat' ? 'text' : messageType,
                      ...(body
                        ? { text: { body } }
                        : messageType !== 'chat'
                          ? {
                              [messageType]: {
                                id: messageId,
                                mime_type: message.mimetype,
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

      const normalizedBody = JSON.stringify(normalizedPayload)

      const result = await processWebhookPayload({
        rawBody: normalizedBody,
        signatureHeader: null,
        payload: normalizedPayload,
      })

      log.info('waha.webhook.processed', {
        session,
        accepted: result.accepted,
        processed: result.processed,
        reason: result.reason,
      })

      return jsonOk(result)
    }

    log.info('webhook.ignored', {
      reason: 'no recognized events',
      event: payload?.event,
    })

    return jsonOk({
      accepted: false,
      processed: 0,
      reason: 'no recognized events',
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return jsonError(error)
    }

    log.error('webhook.error', {
      message: error instanceof Error ? error.message : String(error),
    })

    return jsonOk({ accepted: false, processed: 0 })
  }
}

async function findWahaConnection() {
  const organizationIds = await getWahaOrganizationIds()

  for (const organizationId of organizationIds) {
    const connection = await getConnection(organizationId)

    if (
      connection &&
      connection.statusMessage?.startsWith('waha-adapter')
    ) {
      return connection
    }
  }

  return null
}

async function getWahaOrganizationIds(): Promise<string[]> {
  const { db } = await import('@/lib/db')

  const connections = await db.whatsAppConnection.findMany({
    where: {
      statusMessage: { startsWith: 'waha-adapter' },
    },
    select: { organizationId: true },
  })

  return connections.map((connection) => connection.organizationId)
}
