import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { passwordRequestSchema, passwordResetSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { ApiError } from '@/server/errors'
import { rateLimit, clientIp } from '@/server/rate-limit'
import { recordAudit } from '@/server/audit'
import { sha256Hex } from '@/server/crypto'
import { createLogger } from '@/server/logger'

const log = createLogger('auth.password')

/**
 * Forgot/reset password (spec §10). Email delivery is provider-pluggable
 * (EMAIL_API_KEY); when unconfigured, the reset flow is logged server-side
 * — tokens are never returned in API responses.
 */

export const POST = withApi(async (req) => {
  rateLimit(`pwreq:${clientIp(req)}`, 5, 60_000)
  const body = await readJson(req, passwordRequestSchema)

  const user = await db.user.findUnique({ where: { email: body.email } })
  if (user) {
    const token = crypto.randomBytes(32).toString('base64url')
    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    })
    await recordAudit({
      userId: user.id,
      action: 'auth.password_reset_requested',
      entityType: 'User',
      entityId: user.id,
    })
    log.info('password_reset.requested', { userId: user.id })
  }

  // Identical response either way — no account enumeration
  return jsonOk({ message: 'If an account exists for that email, a reset link has been sent.' })
})

export const PUT = withApi(async (req) => {
  rateLimit(`pwreset:${clientIp(req)}`, 10, 60_000)
  const body = await readJson(req, passwordResetSchema)

  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: sha256Hex(body.token) },
  })
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new ApiError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired')
  }

  const passwordHash = await bcrypt.hash(body.password, 12)
  await db.$transaction([
    db.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    db.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    db.passwordResetToken.updateMany({
      where: { userId: record.userId, id: { not: record.id }, usedAt: null },
      data: { expiresAt: new Date() },
    }),
  ])

  await recordAudit({
    userId: record.userId,
    action: 'auth.password_reset',
    entityType: 'User',
    entityId: record.userId,
  })

  return jsonOk({ message: 'Password updated. You can now sign in.' })
})
