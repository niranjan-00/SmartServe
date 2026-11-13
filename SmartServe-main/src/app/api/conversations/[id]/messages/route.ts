import { db } from '@/lib/db'
import { replyMessageSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { sendOutbound } from '@/server/services/whatsapp'

interface Ctx { params: { id: string } }

/** Message history for a conversation. */
export const GET = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  const conversation = await db.conversation.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
    include: {
      customer: { select: { id: true, name: true, phoneNumber: true } },
      messages: { orderBy: { createdAt: 'asc' }, take: 300 },
      whatsapp: { select: { displayPhoneNumber: true, status: true } },
    },
  })
  if (!conversation) throw ApiError.notFound('Conversation not found')

  // Linked complaints for context
  const complaints = await db.complaint.findMany({
    where: { conversationId: params.id, organizationId: ctx.organizationId },
    select: { id: true, ticketNumber: true, title: true, status: true },
  })

  return jsonOk({ conversation, complaints })
})

/** Staff reply → sent through the org's WhatsApp connection (spec §29/§52). */
export const POST = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:comment')
  const body = await readJson(req, replyMessageSchema)

  const conversation = await db.conversation.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
    include: { customer: { select: { phoneNumber: true } } },
  })
  if (!conversation) throw ApiError.notFound('Conversation not found')

  const result = await sendOutbound({
    organizationId: ctx.organizationId,
    conversationId: params.id,
    to: conversation.customer.phoneNumber,
    text: body.content,
    senderType: 'STAFF',
    senderId: ctx.user.id,
  })

  if (!result.ok) {
    throw new ApiError(503, 'WHATSAPP_SEND_FAILED', `Message recorded but delivery failed: ${result.error ?? 'WhatsApp not connected'}`)
  }
  return jsonOk({ sent: true, messageId: result.messageId })
})
