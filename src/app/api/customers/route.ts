import { db } from '@/lib/db'
import { paginationSchema } from '@/lib/types'
import { withApi, readQuery, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'

/** Customer list with real ticket counts (spec §42). */
export const GET = withApi(async (req) => {
  const ctx = await requireOrganization()
  const { page, pageSize } = readQuery(req, paginationSchema)
  const search = new URL(req.url).searchParams.get('search')?.trim()

  const where: Record<string, unknown> = { organizationId: ctx.organizationId }
  if (search) {
    where.OR = [{ name: { contains: search } }, { phoneNumber: { contains: search } }, { email: { contains: search } }]
  }

  const [total, customers] = await Promise.all([
    db.customer.count({ where }),
    db.customer.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: { select: { complaints: true } },
      },
    }),
  ])

  // Open-ticket counts per customer
  const openCounts = await db.complaint.groupBy({
    by: ['customerId'],
    where: { organizationId: ctx.organizationId, status: { in: ['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'] } },
    _count: { _all: true },
  })
  const satisfaction = await db.feedback.groupBy({
    by: ['customerId'],
    where: { organizationId: ctx.organizationId },
    _avg: { rating: true },
  })

  return jsonOk({
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      phoneNumber: c.phoneNumber,
      email: c.email,
      whatsappId: c.whatsappId,
      createdAt: c.createdAt,
      totalTickets: c._count.complaints,
      openTickets: openCounts.find((o) => o.customerId === c.id)?._count._all ?? 0,
      satisfaction: satisfaction.find((s) => s.customerId === c.id)?._avg.rating ?? null,
    })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  })
})
