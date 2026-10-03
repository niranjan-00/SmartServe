import { z } from 'zod'
import { db } from '@/lib/db'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireAuth } from '@/server/authz'
import { signPayload } from '@/server/crypto'
import { rateLimit } from '@/server/rate-limit'
import { ApiError } from '@/server/errors'

/**
 * Realtime room authorization. The socket.io mini-service calls this
 * endpoint with the user's session to obtain a short-lived signed room
 * token — sockets can only ever join rooms for organizations they belong to.
 */
export const POST = withApi(async (req) => {
  const user = await requireAuth()
  rateLimit(`rtverify:${user.id}`, 30, 60_000)
  const body = await readJson(req, z.object({ organizationId: z.string().min(1) }))

  const membership = await db.organizationMember.findFirst({
    where: { userId: user.id, organizationId: body.organizationId, status: 'ACTIVE' },
  })
  if (!membership) throw ApiError.forbidden('Not a member of this organization')

  const expires = Date.now() + 10 * 60_000
  const payload = `${user.id}.${body.organizationId}.${expires}`
  return jsonOk({
    token: `${payload}.${signPayload(payload)}`,
    userId: user.id,
    organizationId: body.organizationId,
    role: membership.role,
  })
})
