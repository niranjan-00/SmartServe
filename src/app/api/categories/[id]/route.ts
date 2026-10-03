import { db } from '@/lib/db'
import { z } from 'zod'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { recordAudit } from '@/server/audit'

interface Ctx { params: { id: string } }

const updateSchema = z.object({
  description: z.string().trim().max(300).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  defaultPriority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
})

export const PATCH = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'categories:manage')
  const body = await readJson(req, updateSchema)
  const category = await db.category.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
  })
  if (!category) throw ApiError.notFound('Category not found')
  const updated = await db.category.update({
    where: { id: params.id },
    data: body,
  })
  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'category.updated',
    entityType: 'Category',
    entityId: params.id,
    newValue: body,
  })
  return jsonOk({ category: updated })
})

export const DELETE = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'categories:manage')
  const category = await db.category.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
    include: { _count: { select: { complaints: true } } },
  })
  if (!category) throw ApiError.notFound('Category not found')
  if (category._count.complaints > 0) {
    // Soft-disable when in use — history must stay intact
    await db.category.update({ where: { id: params.id }, data: { status: 'INACTIVE' } })
    return jsonOk({ deleted: false, deactivated: true })
  }
  await db.category.delete({ where: { id: params.id } })
  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'category.deleted',
    entityType: 'Category',
    entityId: params.id,
    oldValue: { name: category.name },
  })
  return jsonOk({ deleted: true })
})
