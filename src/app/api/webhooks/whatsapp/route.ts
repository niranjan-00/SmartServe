import { db } from '@/lib/db'
import { withApi, jsonOk } from '@/server/api'
import { verifyWebhook, processWebhookPayload, verifyWebhookSignature } from '@/server/services/whatsapp'
import { rateLimit, clientIp } from '@/server/rate-limit'
import { createLogger } from '@/server/logger'
import { ApiError, jsonError } from '@/server/errors'

const log = createLogger('webhook')

/**
 * Meta WhatsApp webhook endpoint (spec §14/§15/§16).
 *   GET  — hub.challenge verification (requires WHATSAPP_VERIFY_TOKEN)
 *   POST — inbound messages + status updates; persists event first for
 *          idempotency; returns 200 fast; AI runs async (spec §56).
 */

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
    // Meta retries on non-200; throttle only abusive traffic (spec §45)
    rateLimit(`whwebhook:${clientIp(req)}`, 600, 60_000)

    const rawBody = await req.text()
    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      throw ApiError.badRequest('Body must be JSON')
    }

    // Signature verification — required when an app secret is configured.
    // Dev adapter payloads carry no signature; they use the dedicated
    // /api/dev/simulate-message endpoint instead of hitting this route.
    const object = (payload as { object?: string }).object
    if (object === 'whatsapp_business_account') {
      const signature = req.headers.get('x-hub-signature-256')
      const appSecret = process.env.WHATSAPP_APP_SECRET
      if (appSecret) {
        if (!verifyWebhookSignature(rawBody, signature, appSecret)) {
          log.warn('webhook.signature_invalid', { ip: clientIp(req) })
          throw new ApiError(401, 'INVALID_SIGNATURE', 'Signature verification failed')
        }
      }
    }

    const result = await processWebhookPayload({ rawBody, signatureHeader: req.headers.get('x-hub-signature-256'), payload })
    if (!result.accepted) {
      log.info('webhook.ignored', { reason: result.reason })
    }
    // Always 200 for Meta once the event is safely persisted (spec §56)
    return jsonOk(result)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return jsonError(error)
    log.error('webhook.error', { message: error instanceof Error ? error.message : String(error) })
    return jsonOk({ accepted: false, processed: 0 })
  }
}

void db
