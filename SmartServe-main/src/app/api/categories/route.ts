import { db } from '@/lib/db'
import { categorySchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'

export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  const categories = await db.category.findMany({
    where: { organizationId: ctx.organizationId },
    include: {
      department: { select: { id: true, name: true } },
      _count: { select: { complaints: true } },
    },
    orderBy: { name: 'asc' },
  })
  return jsonOk({ categories: categories.map((c) => ({ ...c, complaintCount: c._count.complaints })) })
})

export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'categories:manage')
  const body = await readJson(req, categorySchema)
  const existing = await db.category.findFirst({
    where: { organizationId: ctx.organizationId, name: { equals: body.name } },
  })
  if (existing) throw new ApiError(409, 'CONFLICT', 'A category with this name already exists')

  // Validate department belongs to this organization
  let departmentId: string | null = null
  if (body.departmentId) {
    const department = await db.department.findFirst({
      where: { id: body.departmentId, organizationId: ctx.organizationId },
    })
    if (!department) throw ApiError.badRequest('Invalid department')
    departmentId = department.id
  }

  const category = await db.category.create({
    data: {
      organizationId: ctx.organizationId,
      name: body.name,
      description: body.description,
      departmentId,
      defaultPriority: body.defaultPriority,
      status: body.status,
    },
  })
  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'category.created',
    entityType: 'Category',
    entityId: category.id,
    newValue: { name: category.name },
  })
  await emitToOrganization(ctx.organizationId, 'dashboard.refresh', { reason: 'categories' })
  return jsonOk({ category })
})
