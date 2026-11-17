
import crypto from 'crypto'
import { z } from 'zod'

import { db } from '@/lib/db'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'
import { createLogger } from '@/server/logger'

export const runtime = 'nodejs'

const log = createLogger('member-invitations')

const RESEND_EXPIRY_DAYS = 7

const resendSchema = z.object({
  invitationId: z.string().min(1),
})

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

function getEmailConfiguration() {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL

  if (!apiKey || !from || !appUrl) {
    return null
  }

  try {
    const parsedUrl = new URL(appUrl)

    if (
      process.env.NODE_ENV === 'production' &&
      parsedUrl.protocol !== 'https:'
    ) {
      return null
    }

    return {
      apiKey,
      from,
      appUrl: parsedUrl.origin,
    }
  } catch {
    return null
  }
}

async function sendInvitationEmail(
  email: string,
  code: string,
  expiresAt: Date
): Promise<boolean> {
  const config = getEmailConfiguration()

  if (!config) {
    log.warn('invitation.email_not_configured', { email })
    return false
  }

  const safeEmail = escapeHtml(email)
  const safeCode = escapeHtml(code)
  const safeAppUrl = escapeHtml(config.appUrl)

  const expiryText = expiresAt.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  })

  const safeExpiry = escapeHtml(expiryText)

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [email],
        subject: 'Your SmartServe invitation has been renewed',
        html: `
          <!DOCTYPE html>
          <html>
            <body style="margin:0;padding:30px;background:#f5f7fb;font-family:Arial,sans-serif;">
              <div style="max-width:520px;margin:auto;background:#ffffff;padding:35px;border-radius:12px;">
                <h2 style="color:#172033;">Your invitation is ready</h2>

                <p style="color:#596579;line-height:1.6;">
                  Hello ${safeEmail},
                </p>

                <p style="color:#596579;line-height:1.6;">
                  Your SmartServe organization invitation has been renewed.
                  Use the new invitation code below.
                </p>

                <div style="background:#f1f5ff;padding:18px;border-radius:8px;text-align:center;">
                  <strong style="font-size:25px;letter-spacing:3px;color:#2563eb;">
                    ${safeCode}
                  </strong>
                </div>

                <p style="margin:25px 0;">
                  <a href="${safeAppUrl}"
                    style="background:#3578ee;color:#ffffff;padding:13px 22px;border-radius:7px;text-decoration:none;display:inline-block;font-weight:bold;">
                    Open SmartServe
                  </a>
                </p>

                <p style="color:#596579;font-size:13px;">
                  Sign in and enter this code in the organization joining section.
                </p>

                <p style="color:#596579;font-size:13px;">
                  Expires: ${safeExpiry}
                </p>

                <p style="font-size:12px;color:#9aa3b2;">
                  SmartServe Team
                </p>
              </div>
            </body>
          </html>
        `,
        text: `
Your SmartServe invitation has been renewed.

Invitation code: ${code}

Open SmartServe: ${config.appUrl}

Sign in and enter the code in the organization joining section.

Expires: ${expiryText}
        `,
      }),
    })

    if (!response.ok) {
      const details = await response.text().catch(() => '')

      log.error('invitation.email_failed', {
        email,
        status: response.status,
        details: details.slice(0, 300),
      })

      return false
    }

    log.info('invitation.email_sent', { email })
    return true
  } catch (error) {
    log.error('invitation.email_error', {
      email,
      error: error instanceof Error ? error.message : 'Unknown error',
    })

    return false
  }
}

/**
 * PATCH /api/members/invitations
 *
 * Resend an invitation with a newly generated code.
 */
export const PATCH = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:invite')

  const body = await readJson(req, resendSchema)

  const existing = await db.invitation.findFirst({
    where: {
      id: body.invitationId,
      organizationId: ctx.organizationId,
    },
  })

  if (!existing) {
    throw ApiError.notFound('Invitation not found')
  }

  if (
    existing.status !== 'PENDING' &&
    existing.status !== 'EXPIRED'
  ) {
    throw ApiError.badRequest(
      'Only pending or expired invitations can be resent'
    )
  }

  const now = new Date()
  const newToken = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(
    now.getTime() + RESEND_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  )

  // Atomically renew only an invitation that is still eligible.
  const renewed = await db.invitation.updateMany({
    where: {
      id: existing.id,
      organizationId: ctx.organizationId,
      status: {
        in: ['PENDING', 'EXPIRED'],
      },
    },
    data: {
      token: newToken,
      status: 'PENDING',
      expiresAt,
    },
  })

  if (renewed.count !== 1) {
    throw ApiError.badRequest(
      'This invitation has already been accepted or revoked'
    )
  }

  const emailSent = await sendInvitationEmail(
    existing.email,
    newToken,
    expiresAt
  )

  try {
    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'member.invitation_resent',
      entityType: 'Invitation',
      entityId: existing.id,
      oldValue: {
        status: existing.status,
        expiresAt: existing.expiresAt,
      },
      newValue: {
        status: 'PENDING',
        expiresAt,
        emailSent,
      },
    })
  } catch (error) {
    log.error('invitation.audit_failed', {
      invitationId: existing.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }

  await emitToOrganization(
    ctx.organizationId,
    'member.updated',
    { invitationId: existing.id }
  )

  return jsonOk({
    invitation: {
      id: existing.id,
      email: existing.email,
      role: existing.role,
      status: 'PENDING',
      code: newToken,
      expiresAt,
    },
    emailSent,
    message: emailSent
      ? 'Invitation renewed and email sent successfully.'
      : 'Invitation renewed, but email delivery failed. Share the new code manually.',
  })
})

/**
 * DELETE /api/members/invitations?invitationId=...
 *
 * Revoke a pending invitation.
 */
export const DELETE = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:manage')

  const url = new URL(req.url)
  const invitationId = url.searchParams.get('invitationId')

  if (!invitationId) {
    throw ApiError.badRequest('invitationId is required')
  }

  const invitation = await db.invitation.findFirst({
    where: {
      id: invitationId,
      organizationId: ctx.organizationId,
    },
  })

  if (!invitation) {
    throw ApiError.notFound('Invitation not found')
  }

  if (invitation.status !== 'PENDING') {
    throw ApiError.badRequest(
      'Only pending invitations can be revoked'
    )
  }

  const revoked = await db.invitation.updateMany({
    where: {
      id: invitation.id,
      organizationId: ctx.organizationId,
      status: 'PENDING',
    },
    data: {
      status: 'REVOKED',
    },
  })

  if (revoked.count !== 1) {
    throw ApiError.badRequest(
      'This invitation is no longer pending'
    )
  }

  try {
    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'member.invitation_revoked',
      entityType: 'Invitation',
      entityId: invitation.id,
      oldValue: {
        status: invitation.status,
        email: invitation.email,
      },
      newValue: {
        status: 'REVOKED',
      },
    })
  } catch (error) {
    log.error('invitation.audit_failed', {
      invitationId: invitation.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }

  await emitToOrganization(
    ctx.organizationId,
    'member.updated',
    { invitationId: invitation.id }
  )

  return jsonOk({
    revoked: true,
    message: 'Invitation revoked successfully.',
  })
})
