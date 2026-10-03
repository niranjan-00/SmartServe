import { db } from '@/lib/db'
import { departmentSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'

interface Ctx { params: { id: string } }

export const PATCH = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'departments:manage')
  const body = await readJson(req, departmentSchema)
  const department = await db.department.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
  })
  if (!department) throw ApiError.notFound('Department not found')
  const updated = await db.department.update({
    where: { id: params.id },
    data: { name: body.name, description: body.description },
  })
  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'department.updated',
    entityType: 'Department',
    entityId: params.id,
    newValue: { name: updated.name },
  })
  await emitToOrganization(ctx.organizationId, 'dashboard.refresh', { reason: 'departments' })
  return jsonOk({ department: updated })
})

export const DELETE = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'departments:manage')
  const department = await db.department.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
    include: { _count: { select: { complaints: true } } },
  })
  if (!department) throw ApiError.notFound('Department not found')
  if (department._count.complaints > 0) {
    throw new ApiError(409, 'CONFLICT', 'This department has complaints linked to it and cannot be deleted')
  }
  await db.department.delete({ where: { id: params.id } })
  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'department.deleted',
    entityType: 'Department',
    entityId: params.id,
    oldValue: { name: department.name },
  })
  await emitToOrganization(ctx.organizationId, 'dashboard.refresh', { reason: 'departments' })
  return jsonOk({ deleted: true })
})
