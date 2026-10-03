import { db } from '@/lib/db'
import { paginationSchema } from '@/lib/types'
import { withApi, readQuery, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'

/** Escalation records (spec §32/§33). */
export const GET = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'analytics:read')
  const { page, pageSize } = readQuery(req, paginationSchema)
  const [items, total] = await Promise.all([
    db.escalation.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        complaint: { select: { ticketNumber: true, title: true, status: true } },
        notifiedUser: { select: { name: true } },
      },
    }),
    db.escalation.count({ where: { organizationId: ctx.organizationId } }),
  ])
  return jsonOk({ items, total, page, pageSize })
})
