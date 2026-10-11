import { db } from '@/lib/db'
import { departmentSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'

export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  const departments = await db.department.findMany({
    where: { organizationId: ctx.organizationId },
    include: {
      _count: { select: { complaints: true, members: true, categories: true } },
    },
    orderBy: { name: 'asc' },
  })
  const openByDept = await db.complaint.groupBy({
    by: ['departmentId'],
    where: { organizationId: ctx.organizationId, departmentId: { not: null }, status: { in: ['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'] } },
    _count: { _all: true },
  })
  const resolvedByDept = await db.complaint.groupBy({
    by: ['departmentId'],
    where: { organizationId: ctx.organizationId, departmentId: { not: null }, status: { in: ['RESOLVED', 'CLOSED'] } },
    _count: { _all: true },
  })
  return jsonOk({
    departments: departments.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      staffCount: d._count.members,
      complaintCount: d._count.complaints,
      openComplaints: openByDept.find((o) => o.departmentId === d.id)?._count._all ?? 0,
      resolvedComplaints: resolvedByDept.find((r) => r.departmentId === d.id)?._count._all ?? 0,
      categoryCount: d._count.categories,
    })),
  })
})

export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'departments:manage')
  const body = await readJson(req, departmentSchema)
  const existing = await db.department.findFirst({
    where: { organizationId: ctx.organizationId, name: { equals: body.name } },
  })
  if (existing) throw new (await import('@/server/errors')).ApiError(409, 'CONFLICT', 'A department with this name already exists')
  const department = await db.department.create({
    data: { organizationId: ctx.organizationId, name: body.name, description: body.description },
  })
  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'department.created',
    entityType: 'Department',
    entityId: department.id,
    newValue: { name: department.name },
  })
  await emitToOrganization(ctx.organizationId, 'dashboard.refresh', { reason: 'departments' })
  return jsonOk({ department })
})
