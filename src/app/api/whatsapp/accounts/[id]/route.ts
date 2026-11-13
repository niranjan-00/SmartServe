import { db } from '@/lib/db'
import { withApi, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { callBaileysWorker } from '@/server/services/whatsapp/baileys-client'

export const GET = withApi<{ id: string }>(async (_req, context) => {
  const ctx = await requireOrganization()
  const { id } = context.params
  const account = await db.whatsAppAccount.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, label: true, phoneNumber: true, status: true, lastConnectedAt: true, lastError: true, createdAt: true },
  })
  if (!account) throw ApiError.notFound('WhatsApp account not found')
  return jsonOk({ account })
})

export const DELETE = withApi<{ id: string }>(async (_req, context) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')
  const { id } = context.params
  const account = await db.whatsAppAccount.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })
  if (!account) throw ApiError.notFound('WhatsApp account not found')
  try { await callBaileysWorker(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }) } catch { /* allow cleanup if worker is offline */ }
  await db.whatsAppAccount.delete({ where: { id } })
  return jsonOk({ disconnected: true })
})
