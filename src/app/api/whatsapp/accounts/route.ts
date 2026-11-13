import { db } from '@/lib/db'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { whatsappAccountSchema } from '@/lib/types'
import { callBaileysWorker } from '@/server/services/whatsapp/baileys-client'
import { ApiError } from '@/server/errors'

export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  const accounts = await db.whatsAppAccount.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, label: true, phoneNumber: true, status: true, lastConnectedAt: true, lastError: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  return jsonOk({ accounts })
})

export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')
  const body = await readJson<{ label: string }>(req, whatsappAccountSchema)
  const account = await db.whatsAppAccount.create({
    data: { organizationId: ctx.organizationId, label: body.label, status: 'CONNECTING' },
    select: { id: true, label: true, phoneNumber: true, status: true, lastConnectedAt: true, lastError: true, createdAt: true },
  })
  try {
    await callBaileysWorker('/sessions', { method: 'POST', body: JSON.stringify({ accountId: account.id }) })
  } catch (error) {
    await db.whatsAppAccount.delete({ where: { id: account.id } })
    throw new ApiError(503, 'WHATSAPP_WORKER_UNAVAILABLE', error instanceof Error ? error.message : 'WhatsApp worker unavailable')
  }
  return jsonOk({ account }, { status: 201 })
})
