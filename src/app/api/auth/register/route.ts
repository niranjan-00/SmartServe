import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { registerSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { ApiError } from '@/server/errors'
import { rateLimit, clientIp } from '@/server/rate-limit'
import { recordAudit } from '@/server/audit'
import { ensureBackgroundJobs } from '@/server/jobs'

export const POST = withApi(async (req) => {
  ensureBackgroundJobs()
  rateLimit(`register:${clientIp(req)}`, 10, 60_000)
  const body = await readJson(req, registerSchema)

  const existing = await db.user.findUnique({ where: { email: body.email } })
  if (existing) throw ApiError.conflict('An account with this email already exists')

  const passwordHash = await bcrypt.hash(body.password, 12)
  const user = await db.user.create({
    data: { name: body.name, email: body.email, passwordHash },
    select: { id: true, name: true, email: true },
  })

  await recordAudit({
    userId: user.id,
    action: 'auth.register',
    entityType: 'User',
    entityId: user.id,
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent') || undefined,
  })

  return jsonOk({ user })
})
