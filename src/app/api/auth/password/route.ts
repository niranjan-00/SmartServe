
import crypto from 'crypto'
import bcrypt from 'bcryptjs'

import { db } from '@/lib/db'

import {
  passwordRequestSchema,
  passwordResetSchema,
} from '@/lib/types'

import {
  withApi,
  readJson,
  jsonOk,
} from '@/server/api'

import { ApiError } from '@/server/errors'

import {
  rateLimit,
  clientIp,
} from '@/server/rate-limit'

import { recordAudit } from '@/server/audit'
import { sha256Hex } from '@/server/crypto'
import { createLogger } from '@/server/logger'

export const runtime = 'nodejs'

const log = createLogger('auth.password')

const RESET_EXPIRY_MINUTES = 30

/**
 * Escape dynamic values before inserting them into HTML.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }

    return entities[char]
  })
}

/**
 * Validate the email configuration.
 *
 * Missing configuration returns 503 so the frontend
 * can display the appropriate message.
 */
function getEmailConfiguration() {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL

  const appUrl =
    process.env.NEXTAUTH_URL ||
    process.env.APP_URL

  if (!apiKey || !from || !appUrl) {
    throw new ApiError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Password reset email service is not configured.',
    )
  }

  let parsedUrl: URL

  try {
    parsedUrl = new URL(appUrl)
  } catch {
    throw new ApiError(
      503,
      'INVALID_EMAIL_CONFIGURATION',
      'Password reset email service is not configured correctly.',
    )
  }

  if (
    parsedUrl.protocol !== 'https:' &&
    process.env.NODE_ENV === 'production'
  ) {
    throw new ApiError(
      503,
      'INVALID_EMAIL_CONFIGURATION',
      'Password reset email service requires a secure application URL.',
    )
  }

  return {
    apiKey,
    from,
    appUrl: parsedUrl.origin,
  }
}

/**
 * Send password reset email through Resend.
 */
async function sendResetEmail(
  email: string,
  token: string,
): Promise<void> {
  const { apiKey, from, appUrl } =
    getEmailConfiguration()

  const resetUrl = new URL(
    '/reset-password',
    appUrl,
  )

  resetUrl.searchParams.set('token', token)

  const resetLink = resetUrl.toString()
  const safeUrl = escapeHtml(resetLink)

  const response = await fetch(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Reset your SmartServe password',

        html: `
          <!DOCTYPE html>
          <html>
            <body style="margin:0;padding:30px;background:#f5f7fb;font-family:Arial,sans-serif;">
              <div style="max-width:520px;margin:auto;background:#ffffff;padding:35px;border-radius:12px;">
                <h2 style="color:#172033;">Reset your password</h2>

                <p style="color:#596579;line-height:1.6;">
                  We received a request to reset your SmartServe account password.
                </p>

                <p style="margin:28px 0;">
                  <a
                    href="${safeUrl}"
                    style="background:#3578ee;color:#ffffff;padding:13px 22px;border-radius:7px;text-decoration:none;display:inline-block;font-weight:bold;"
                  >
                    Reset Password
                  </a>
                </p>

                <p style="color:#596579;font-size:13px;">
                  This link expires in ${RESET_EXPIRY_MINUTES} minutes
                  and can only be used once.
                </p>

                <p style="color:#596579;font-size:13px;">
                  If you did not request a password reset,
                  you can safely ignore this email.
                </p>

                <hr style="border:none;border-top:1px solid #eeeeee;margin:25px 0;" />

                <p style="font-size:12px;color:#9aa3b2;">
                  SmartServe Security Team
                </p>
              </div>
            </body>
          </html>
        `,

        text: `
Reset your SmartServe password.

Open this link:
${resetLink}

This link expires in ${RESET_EXPIRY_MINUTES} minutes
and can only be used once.

If you did not request this reset, ignore this email.
        `,
      }),
    },
  )

  if (!response.ok) {
    const details = await response
      .text()
      .catch(() => '')

    log.error('password_reset.email_failed', {
      status: response.status,
      details: details.slice(0, 300),
    })

    throw new Error(
      'Password reset email delivery failed.',
    )
  }
}

/**
 * Best-effort audit logging.
 *
 * Audit failures must not invalidate an email that
 * has already been sent or undo a successful reset.
 */
async function auditPasswordReset(
  userId: string,
  action: string,
) {
  try {
    await recordAudit({
      userId,
      action,
      entityType: 'User',
      entityId: userId,
    })
  } catch (error) {
    log.error('password_reset.audit_failed', {
      userId,
      action,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error',
    })
  }
}

/**
 * POST /api/auth/password
 *
 * Request a password reset.
 */
export const POST = withApi(async (req) => {
  rateLimit(
    `pwreq:${clientIp(req)}`,
    5,
    60_000,
  )

  const body = await readJson(
    req,
    passwordRequestSchema,
  )

  const email = body.email
    .trim()
    .toLowerCase()

  // Check configuration before looking up the user.
  // This also keeps the response independent of account existence.
  getEmailConfiguration()

  const user = await db.user.findUnique({
    where: { email },
  })

  if (user) {
    const token = crypto
      .randomBytes(32)
      .toString('base64url')

    const tokenHash = sha256Hex(token)

    const now = new Date()

    const expiresAt = new Date(
      now.getTime() +
        RESET_EXPIRY_MINUTES * 60 * 1000,
    )

    // Invalidate previous unused reset links.
    await db.passwordResetToken.updateMany({
      where: {
        userId: user.id,
        usedAt: null,
      },
      data: {
        expiresAt: now,
      },
    })

    // Store only the hashed token.
    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    })

    try {
      await sendResetEmail(
        user.email,
        token,
      )
    } catch (error) {
      // Invalidate this token if email delivery fails.
      await db.passwordResetToken.updateMany({
        where: {
          userId: user.id,
          tokenHash,
          usedAt: null,
        },
        data: {
          expiresAt: new Date(),
        },
      })

      log.error('password_reset.request_failed', {
        userId: user.id,
        error:
          error instanceof Error
            ? error.message
            : 'Unknown error',
      })

      // Keep the response generic to avoid account enumeration.
      return jsonOk({
        message:
          'If an account exists for that email, a reset link has been sent.',
      })
    }

    log.info('password_reset.email_sent', {
      userId: user.id,
    })

    // Audit failure must not invalidate the sent reset link.
    await auditPasswordReset(
      user.id,
      'auth.password_reset_requested',
    )
  }

  // Never reveal whether the email exists.
  return jsonOk({
    message:
      'If an account exists for that email, a reset link has been sent.',
  })
})

/**
 * PUT /api/auth/password
 *
 * Reset password using a valid token.
 */
export const PUT = withApi(async (req) => {
  rateLimit(
    `pwreset:${clientIp(req)}`,
    10,
    60_000,
  )

  const body = await readJson(
    req,
    passwordResetSchema,
  )

  const tokenHash = sha256Hex(body.token)

  const record =
    await db.passwordResetToken.findUnique({
      where: { tokenHash },
    })

  const now = new Date()

  if (
    !record ||
    record.usedAt ||
    record.expiresAt <= now
  ) {
    throw new ApiError(
      400,
      'INVALID_TOKEN',
      'This reset link is invalid or has expired.',
    )
  }

  // Hash the new password before entering the transaction.
  const passwordHash = await bcrypt.hash(
    body.password,
    12,
  )

  // Claim the token and update the password atomically.
  await db.$transaction(async (tx) => {
    const claimed =
      await tx.passwordResetToken.updateMany({
        where: {
          id: record.id,
          usedAt: null,
          expiresAt: {
            gt: now,
          },
        },
        data: {
          usedAt: now,
        },
      })

    // Another request may already have consumed the token.
    if (claimed.count !== 1) {
      throw new ApiError(
        400,
        'INVALID_TOKEN',
        'This reset link is invalid or has expired.',
      )
    }

    // Update the user's password.
    await tx.user.update({
      where: {
        id: record.userId,
      },
      data: {
        passwordHash,
      },
    })

    // Invalidate all other outstanding reset tokens.
    await tx.passwordResetToken.updateMany({
      where: {
        userId: record.userId,
        id: {
          not: record.id,
        },
        usedAt: null,
      },
      data: {
        expiresAt: now,
      },
    })
  })

  log.info('password_reset.completed', {
    userId: record.userId,
  })

  // Audit logging happens after the successful transaction.
  await auditPasswordReset(
    record.userId,
    'auth.password_reset',
  )

  return jsonOk({
    message:
      'Password updated. You can now sign in.',
  })
})
