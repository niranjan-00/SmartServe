import { whatsappConnectSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { getConnectionSummary, connectWhatsApp, disconnectWhatsApp, isDevelopmentMode } from '@/server/services/whatsapp'
import { recordAudit } from '@/server/audit'
import { ApiError } from '@/server/errors'

/**
 * WhatsApp connection management (spec §12/§54).
 * GET returns real connection state — the UI never fakes CONNECTED.
 * Access tokens are encrypted at rest and never returned to the client.
 */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  const connection = await getConnectionSummary(ctx.organizationId)
  return jsonOk({ connection, developmentMode: isDevelopmentMode() })
})

/** POST: "Connect WhatsApp Business" with real Cloud API credentials. */
export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')
  const body = await readJson(req, whatsappConnectSchema)

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
    throw new ApiError(400, 'WHATSAPP_VERIFY_FAILED', connection.statusMessage ?? 'Meta verification failed')
  }

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'whatsapp.connected',
    entityType: 'WhatsAppConnection',
    entityId: connection.id,
    newValue: { status: connection.status, mode: connection.mode, phoneNumberId: connection.phoneNumberId },
    ipAddress: req.headers.get('x-forwarded-for') || undefined,
  })

  return jsonOk({ connection })
})

/** DELETE: disconnect. */
export const DELETE = withApi(async () => {
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
