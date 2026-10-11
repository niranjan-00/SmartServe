import { paginationSchema } from '@/lib/types'
import { withApi, readQuery, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { db } from '@/lib/db'

/** Immutable audit trail (spec §41/§48) — admin read-only access. */
export const GET = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'audit:read')
  const { page, pageSize } = readQuery(req, paginationSchema)
  const search = new URL(req.url).searchParams.get('search')?.trim()

  const where: Record<string, unknown> = { organizationId: ctx.organizationId }
  if (search) {
    where.OR = [
      { action: { contains: search } },
      { entityType: { contains: search } },
      { entityId: { contains: search } },
    ]
  }

  const [items, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: { select: { name: true, email: true } } },
    }),
    db.auditLog.count({ where }),
  ])
  return jsonOk({ items, total, page, pageSize })
})
