import { z } from 'zod'
import { db } from '@/lib/db'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { simulateInboundMessage, isDevelopmentMode } from '@/server/services/whatsapp'
import { ApiError } from '@/server/errors'

const simulateSchema = z.object({
  from: z.string().trim().min(6).max(24),
  text: z.string().trim().min(1).max(2000),
  profileName: z.string().trim().max(80).optional(),
})

/**
 * DEVELOPMENT ADAPTER (spec §12): simulates an inbound customer WhatsApp
 * message by running the EXACT production webhook pipeline against a
 * Meta-shaped payload. Disabled unless WHATSAPP_MODE != 'production' and a
 * connection exists (development adapter). Never registered in production.
 */
export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:create')
  if (!isDevelopmentMode()) {
    throw ApiError.forbidden('Message simulation is disabled in production mode')
  }
  const body = await readJson(req, simulateSchema)

  const connection = await db.whatsAppConnection.findUnique({ where: { organizationId: ctx.organizationId } })
  if (!connection) {
    throw ApiError.badRequest('Connect WhatsApp (development adapter) before simulating messages')
  }

  const result = await simulateInboundMessage({
    organizationId: ctx.organizationId,
    from: body.from,
    text: body.text,
    profileName: body.profileName,
  })
  return jsonOk(result)
})
