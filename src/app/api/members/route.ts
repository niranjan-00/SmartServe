
import { z } from 'zod'

import { db } from '@/lib/db'
import { inviteMemberSchema, updateMemberSchema } from '@/lib/types'
import { withApi, readJson, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'

import {
  inviteMember,
  listMembers,
  listPendingInvitations,
} from '@/server/services/organization-service'

import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'
import { createLogger } from '@/server/logger'

export const runtime = 'nodejs'

const log = createLogger('members')

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
 * Send organization invitation email through Resend.
 *
 * Email configuration:
 * RESEND_API_KEY
 * RESEND_FROM_EMAIL
 * NEXTAUTH_URL or APP_URL
 */
async function sendInvitationEmail(
  email: string,
  code: string,
  expiresAt: Date | null
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL

  // Keep the invitation usable through the existing join-code flow
  // even when email delivery is not configured.
  if (!apiKey || !from || !appUrl) {
    log.warn('invitation.email_not_configured', { email })
    return false
  }

  let baseUrl: string

  try {
    const parsedUrl = new URL(appUrl)

    if (
      process.env.NODE_ENV === 'production' &&
      parsedUrl.protocol !== 'https:'
    ) {
      log.error('invitation.invalid_app_url')
      return false
    }

    baseUrl = parsedUrl.origin
  } catch {
    log.error('invitation.invalid_app_url')
    return false
  }

  const safeEmail = escapeHtml(email)
  const safeCode = escapeHtml(code)
  const safeAppUrl = escapeHtml(baseUrl)

  const expiryText = expiresAt
    ? expiresAt.toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      })
    : 'the expiry date shown by your administrator'

  const safeExpiry = escapeHtml(expiryText)

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'You are invited to join SmartServe',
      html: `
        <!DOCTYPE html>
        <html>
          <body style="margin:0;padding:30px;background:#f5f7fb;font-family:Arial,sans-serif;">
            <div style="max-width:520px;margin:auto;background:#ffffff;padding:35px;border-radius:12px;">
              <h2 style="color:#172033;">You're invited to SmartServe</h2>

              <p style="color:#596579;line-height:1.6;">
                Hello ${safeEmail},
              </p>

              <p style="color:#596579;line-height:1.6;">
                An organization administrator has invited you to join their
                organization on SmartServe.
              </p>

              <p style="color:#596579;">
                Your invitation code:
              </p>

              <div style="background:#f1f5ff;padding:18px;border-radius:8px;text-align:center;">
                <strong style="font-size:25px;letter-spacing:3px;color:#2563eb;">
                  ${safeCode}
                </strong>
              </div>

              <p style="color:#596579;line-height:1.6;">
                Sign in to SmartServe and enter this code in the
                organization joining section.
              </p>

              <p style="margin:25px 0;">
                <a
                  href="${safeAppUrl}"
                  style="background:#3578ee;color:#ffffff;padding:13px 22px;border-radius:7px;text-decoration:none;display:inline-block;font-weight:bold;"
                >
                  Open SmartServe
                </a>
              </p>

              <p style="color:#596579;font-size:13px;">
                Invitation expiry: ${safeExpiry}
              </p>

              <p style="color:#596579;font-size:13px;">
                If you were not expecting this invitation, you can ignore
                this email.
              </p>

              <hr style="border:none;border-top:1px solid #eeeeee;margin:25px 0;" />

              <p style="font-size:12px;color:#9aa3b2;">
                SmartServe Team
              </p>
            </div>
          </body>
        </html>
      `,
      text: `
You are invited to join SmartServe.

Your invitation code: ${code}

Open SmartServe: ${baseUrl}

Sign in and enter this code in the organization joining section.

Invitation expiry: ${expiryText}

If you were not expecting this invitation, ignore this email.
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
}

/**
 * GET: organization members + pending invitations.
 */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()

  await requirePermission(ctx, 'members:read')

  const [members, invitations] = await Promise.all([
    listMembers(ctx),
    listPendingInvitations(ctx),
  ])

  return jsonOk({
    members,
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      departmentId: invitation.departmentId,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    })),
  })
})

/**
 * POST: invite a member by email.
 *
 * Creates the invitation and attempts to send an email.
 * Returns the invitation code as a fallback if email delivery fails.
 */
export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()

  await requirePermission(ctx, 'members:invite')

  const body = await readJson(req, inviteMemberSchema)

  const email = body.email.trim().toLowerCase()

  const invitation = await inviteMember(
    ctx,
    email,
    body.role,
    body.departmentId
  )

  let emailSent = false

  try {
    emailSent = await sendInvitationEmail(
      invitation.email,
      invitation.token,
      invitation.expiresAt
    )
  } catch (error) {
    log.error('invitation.email_error', {
      email,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error',
    })
  }

  try {
    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'member.invited',
      entityType: 'Invitation',
      entityId: invitation.id,
      newValue: {
        email: invitation.email,
        role: invitation.role,
        emailSent,
      },
    })
  } catch (error) {
    log.error('invitation.audit_failed', {
      invitationId: invitation.id,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error',
    })
  }

  await emitToOrganization(
    ctx.organizationId,
    'member.updated',
    {
      invitationId: invitation.id,
    }
  )

  return jsonOk({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      code: invitation.token,
      expiresAt: invitation.expiresAt,
    },
    emailSent,
    message: emailSent
      ? 'Invitation created and email sent successfully.'
      : 'Invitation created, but email delivery was unsuccessful. Share the invitation code manually.',
  })
})

/**
 * PATCH: update member role, status or department.
 */
export const PATCH = withApi(async (req) => {
  const ctx = await requireOrganization()

  await requirePermission(ctx, 'members:manage')

  const schema = updateMemberSchema.extend({
    memberId: z.string().min(1),
  })

  const body = await readJson(req, schema)

  const member = await db.organizationMember.findFirst({
    where: {
      id: body.memberId,
      organizationId: ctx.organizationId,
    },
  })

  if (!member) {
    throw ApiError.notFound('Member not found')
  }

  // Prevent demoting the final active organization administrator.
  if (
    member.role === 'ORGANIZATION_ADMIN' &&
    body.role &&
    body.role !== 'ORGANIZATION_ADMIN'
  ) {
    const admins = await db.organizationMember.count({
      where: {
        organizationId: ctx.organizationId,
        role: 'ORGANIZATION_ADMIN',
        status: 'ACTIVE',
      },
    })

    if (admins <= 1) {
      throw ApiError.badRequest(
        'Organization must retain at least one admin'
      )
    }
  }

  // Validate department ownership before updating.
  if (body.departmentId) {
    const department = await db.department.findFirst({
      where: {
        id: body.departmentId,
        organizationId: ctx.organizationId,
      },
      select: { id: true },
    })

    if (!department) {
      throw ApiError.badRequest(
        'Department does not belong to this organization'
      )
    }
  }

  const updated = await db.organizationMember.update({
    where: { id: member.id },
    data: {
      role: body.role,
      status: body.status,
      departmentId:
        body.departmentId === undefined
          ? undefined
          : body.departmentId,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  })

  if (body.role && body.role !== member.role) {
    await recordAudit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: 'member.role_changed',
      entityType: 'OrganizationMember',
      entityId: member.id,
      oldValue: { role: member.role },
      newValue: { role: body.role },
    })
  }

  await emitToOrganization(
    ctx.organizationId,
    'member.updated',
    { memberId: member.id }
  )

  return jsonOk({ member: updated })
})

/**
 * DELETE: remove a member using ?memberId=.
 */
export const DELETE = withApi(async (req) => {
  const ctx = await requireOrganization()

  await requirePermission(ctx, 'members:manage')

  const url = new URL(req.url)
  const memberId = url.searchParams.get('memberId')

  if (!memberId) {
    throw ApiError.badRequest('memberId is required')
  }

  const member = await db.organizationMember.findFirst({
    where: {
      id: memberId,
      organizationId: ctx.organizationId,
    },
  })

  if (!member) {
    throw ApiError.notFound('Member not found')
  }

  if (member.role === 'ORGANIZATION_ADMIN') {
    const admins = await db.organizationMember.count({
      where: {
        organizationId: ctx.organizationId,
        role: 'ORGANIZATION_ADMIN',
        status: 'ACTIVE',
      },
    })

    if (admins <= 1) {
      throw ApiError.badRequest(
        'Organization must retain at least one admin'
      )
    }
  }

  if (member.userId === ctx.user.id) {
    throw ApiError.badRequest('You cannot remove yourself')
  }

  await db.organizationMember.delete({
    where: { id: member.id },
  })

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'member.removed',
    entityType: 'OrganizationMember',
    entityId: member.id,
    oldValue: { role: member.role },
  })

  await emitToOrganization(
    ctx.organizationId,
    'member.updated',
    { memberId: member.id }
  )

  return jsonOk({ removed: true })
})
