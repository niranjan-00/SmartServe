
import { whatsappConnectSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import {
  getConnectionSummary,
  connectWhatsApp,
  disconnectWhatsApp,
  isDevelopmentMode,
  connectWahaWhatsApp,
} from '@/server/services/whatsapp'
import { recordAudit } from '@/server/audit'
import { ApiError } from '@/server/errors'

/**
 * WhatsApp connection management.
 *
 * GET: Return the real connection state.
 * POST: Connect using Meta Cloud API or WAHA.
 * DELETE: Disconnect the current WhatsApp connection.
 *
 * Secrets must never be returned to the client.
 */

export const GET = withApi(async () => {
  const ctx = await requireOrganization()

  const connection = await getConnectionSummary(ctx.organizationId)

  return jsonOk({
    connection,
    developmentMode: isDevelopmentMode(),
  })
})

/**
 * POST supports two providers:
 *
 * Meta:
 * {
 *   "provider": "meta",
 *   "wabaId": "...",
 *   "phoneNumberId": "...",
 *   "displayPhoneNumber": "...",
 *   "accessToken": "...",
 *   "verifyToken": "...",
 *   "appSecret": "..."
 * }
 *
 * WAHA:
 * {
 *   "provider": "waha"
 * }
 *
 * WAHA credentials should be configured as server-side environment
 * variables. Never accept the WAHA API key from the browser.
 */
export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')

  const rawBody: unknown = await req.json().catch(() => {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON')
  })

  if (
    typeof rawBody === 'object' &&
    rawBody !== null &&
    'provider' in rawBody &&
    rawBody.provider === 'waha'
  ) {
    const connection = await connectWahaWhatsApp({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    })

    if (connection.status === 'ERROR') {
      throw new ApiError(
        400,
        'WHATSAPP_WAHA_CONNECT_FAILED',
        connection.statusMessage ?? 'WAHA connection failed',
      )
    }

    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'whatsapp.connected',
      entityType: 'WhatsAppConnection',
      entityId: connection.id,
      newValue: {
        status: connection.status,
        mode: connection.mode,
        phoneNumberId: connection.phoneNumberId,
      },
      ipAddress: req.headers.get('x-forwarded-for') || undefined,
    })

    return jsonOk({ connection })
  }

  // Preserve the existing Meta Cloud API flow.
  const body = whatsappConnectSchema.parse(rawBody)

  const connection = await connectWhatsApp({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    wabaId: body.wabaId,
    phoneNumberId: body.phoneNumberId,
    displayPhoneNumber: body.displayPhoneNumber,
    accessToken: body.accessToken,
    verifyToken: body.verifyToken,
    appSecret: body.appSecret,
  })

  if (connection.status === 'ERROR') {
    throw new ApiError(
      400,
      'WHATSAPP_VERIFY_FAILED',
      connection.statusMessage ?? 'Meta verification failed',
    )
  }

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'whatsapp.connected',
    entityType: 'WhatsAppConnection',
    entityId: connection.id,
    newValue: {
      status: connection.status,
      mode: connection.mode,
      phoneNumberId: connection.phoneNumberId,
    },
    ipAddress: req.headers.get('x-forwarded-for') || undefined,
  })

  return jsonOk({ connection })
})

/** DELETE: Disconnect the current organization's WhatsApp connection. */
export const DELETE = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')

  await disconnectWhatsApp(ctx.organizationId)

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'whatsapp.disconnected',
    entityType: 'WhatsAppConnection',
  })

  return jsonOk({ disconnected: true })
})