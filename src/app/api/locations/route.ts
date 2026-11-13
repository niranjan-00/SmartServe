import { db } from '@/lib/db'
import { locationSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { recordAudit } from '@/server/audit'

export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  const locations = await db.location.findMany({
    where: { organizationId: ctx.organizationId },
    include: { _count: { select: { complaints: true } } },
    orderBy: { name: 'asc' },
  })
  return jsonOk({ locations: locations.map((l) => ({ ...l, complaintCount: l._count.complaints })) })
})

export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'locations:manage')
  const body = await readJson(req, locationSchema)
  const existing = await db.location.findFirst({
    where: { organizationId: ctx.organizationId, name: { equals: body.name } },
  })
  if (existing) throw new ApiError(409, 'CONFLICT', 'A location with this name already exists')
  const location = await db.location.create({
    data: { organizationId: ctx.organizationId, name: body.name, description: body.description },
  })
  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'location.created',
    entityType: 'Location',
    entityId: location.id,
    newValue: { name: location.name },
  })
  return jsonOk({ location })
})
