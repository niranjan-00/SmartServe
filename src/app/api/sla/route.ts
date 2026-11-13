import { db } from '@/lib/db'
import { slaSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { getSlaPolicies } from '@/server/services/sla-service'
import { recordAudit } from '@/server/audit'
import { ApiError } from '@/server/errors'
import type { Priority } from '@/lib/types'

/** SLA configuration (spec §30/§32). */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  const policies = await getSlaPolicies(ctx.organizationId)
  return jsonOk({ policies })
})

/** PUT: upsert per-priority SLA policies. */
export const PUT = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'sla:manage')
  const body = await readJson(req, z.object({ policies: z.array(slaSchema).min(1).max(4) }))

  for (const policy of body.policies) {
    await db.sLA.upsert({
      where: { organizationId_priority: { organizationId: ctx.organizationId, priority: policy.priority } },
      create: {
        organizationId: ctx.organizationId,
        priority: policy.priority,
        firstResponseMinutes: policy.firstResponseMinutes,
        resolutionMinutes: policy.resolutionMinutes,
        escalationMinutes: policy.escalationMinutes ?? null,
        enabled: policy.enabled,
      },
      update: {
        firstResponseMinutes: policy.firstResponseMinutes,
        resolutionMinutes: policy.resolutionMinutes,
        escalationMinutes: policy.escalationMinutes ?? null,
        enabled: policy.enabled,
      },
    })
  }

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'sla.updated',
    entityType: 'SLA',
    newValue: body.policies,
  })
  void ApiError

  const policies = await getSlaPolicies(ctx.organizationId)
  return jsonOk({ policies: policies as Record<Priority, unknown> })
})
