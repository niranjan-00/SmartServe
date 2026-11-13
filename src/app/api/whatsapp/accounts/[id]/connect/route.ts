import { withApi, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { db } from '@/lib/db'
import { callBaileysWorker } from '@/server/services/whatsapp/baileys-client'
import { ApiError } from '@/server/errors'

export const POST = withApi<{ id: string }>(async (_req, context) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')
  const { id } = context.params
  const account = await db.whatsAppAccount.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })
  if (!account) throw ApiError.notFound('WhatsApp account not found')
  await callBaileysWorker('/sessions', { method: 'POST', body: JSON.stringify({ accountId: id }) })
  await db.whatsAppAccount.update({ where: { id }, data: { status: 'CONNECTING', lastError: null } })
  return jsonOk({ reconnecting: true })
})
