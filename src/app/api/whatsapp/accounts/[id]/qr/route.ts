import { withApi, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { db } from '@/lib/db'
import { callBaileysWorker } from '@/server/services/whatsapp/baileys-client'
import { ApiError } from '@/server/errors'

export const GET = withApi<{ id: string }>(async (_req, context) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')
  const { id } = context.params
  const account = await db.whatsAppAccount.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })
  if (!account) throw ApiError.notFound('WhatsApp account not found')
  const result = await callBaileysWorker(`/sessions/${encodeURIComponent(id)}/qr`)
  return jsonOk(result)
})
