import { db } from '@/lib/db'
import { paginationSchema } from '@/lib/types'
import { withApi, readQuery, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'

/** Conversation list for the Conversations view (spec §52). */
export const GET = withApi(async (req) => {
  const ctx = await requireOrganization()
  const { page, pageSize } = readQuery(req, paginationSchema)
  const search = new URL(req.url).searchParams.get('search')?.trim()

  const where: Record<string, unknown> = { organizationId: ctx.organizationId }
  if (search) {
    where.customer = { is: { OR: [{ name: { contains: search } }, { phoneNumber: { contains: search } }] } }
  }

  const [total, conversations] = await Promise.all([
    db.conversation.count({ where }),
    db.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        customer: { select: { id: true, name: true, phoneNumber: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, createdAt: true, direction: true } },
        _count: { select: { messages: true } },
        whatsapp: { select: { displayPhoneNumber: true, status: true } },
      },
    }),
  ])

  return jsonOk({
    conversations: conversations.map((c) => ({
      id: c.id,
      status: c.status,
      customer: c.customer,
      lastMessage: c.messages[0]?.content ?? null,
      lastMessageAt: c.lastMessageAt,
      messageCount: c._count.messages,
      connection: c.whatsapp,
    })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  })
})
