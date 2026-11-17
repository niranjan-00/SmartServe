
import crypto from 'crypto'
import { z } from 'zod'

import { db } from '@/lib/db'
import { withApi, readJson, jsonOk } from '@/server/api'
import { ApiError } from '@/server/errors'
import {
  requireOrganization,
  requirePermission,
} from '@/server/authz'
import { getStaffMetrics } from '@/server/services/analytics-service'

const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(['STAFF', 'SUPERVISOR', 'VIEWER']).default('STAFF'),
  departmentId: z.string().trim().min(1).optional().nullable(),
})

const INVITATION_EXPIRY_HOURS = 48

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

async function sendInvitationEmail(params: {
  email: string
  organizationName: string
  role: string
  invitationUrl: string
}) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL

  if (!apiKey || !from) {
    throw new Error('Invitation email configuration is missing.')
  }

  const organizationName = escapeHtml(params.organizationName)
  const role = escapeHtml(params.role.replace('_', ' ').toLowerCase())
  const safeUrl = escapeHtml(params.invitationUrl)

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [params.email],
      subject: `You're invited to join ${params.organizationName} on SmartServe`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;padding:30px;color:#172033">
          <h2>You're invited to SmartServe</h2>
          <p>You have been invited to join <strong>${organizationName}</strong>.</p>
          <p>Your assigned role: <strong>${role}</strong></p>
          <p style="margin:28px 0">
            <a href="${safeUrl}" style="background:#3578ee;color:white;padding:13px 22px;border-radius:7px;text-decoration:none">
              Accept Invitation
            </a>
          </p>
          <p>This invitation expires in ${INVITATION_EXPIRY_HOURS} hours.</p>
          <p>If you weren't expecting this invitation, you can ignore this email.</p>
          <hr />
          <small>SmartServe Team</small>
        </div>
      `,
      text: `
You've been invited to join ${params.organizationName} on SmartServe.

Role: ${params.role}

Accept your invitation:
${params.invitationUrl}

This invitation expires in ${INVITATION_EXPIRY_HOURS} hours.
      `,
    }),
  })

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(
      `Invitation email failed (${response.status}): ${details.slice(0, 300)}`
    )
  }
}

/**
 * GET /api/staff
 * Existing staff operational metrics.
 */
export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'staff:read')

  const staff = await getStaffMetrics(ctx.organizationId)

  return jsonOk({ staff })
})

/**
 * POST /api/staff
 * Invite a new organization member.
 */
export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'members:invite')

  const body = await readJson(req, inviteSchema)

  const email = body.email.toLowerCase()
  const role = body.role
  const departmentId = body.departmentId || null

  // Prevent inviting an existing organization member.
  const existingUser = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      memberships: {
        where: {
          organizationId: ctx.organizationId,
        },
        select: { id: true },
      },
    },
  })

  if (existingUser?.memberships.length) {
    throw new ApiError(
      409,
      'ALREADY_MEMBER',
      'This user is already a member of your organization.'
    )
  }

  // Verify that the selected department belongs to this organization.
  if (departmentId) {
    const department = await db.department.findFirst({
      where: {
        id: departmentId,
        organizationId: ctx.organizationId,
      },
      select: { id: true },
    })

    if (!department) {
      throw new ApiError(
        400,
        'INVALID_DEPARTMENT',
        'The selected department does not belong to this organization.'
      )
    }
  }

  const organization = await db.organization.findUnique({
    where: { id: ctx.organizationId },
    select: { name: true },
  })

  if (!organization) {
    throw new ApiError(
      404,
      'ORGANIZATION_NOT_FOUND',
      'Organization not found.'
    )
  }

  const now = new Date()
  const expiresAt = new Date(
    now.getTime() + INVITATION_EXPIRY_HOURS * 60 * 60 * 1000
  )

  const token = crypto.randomBytes(32).toString('hex')

  // Reuse the organization's existing invitation record if one exists.
  const invitation = await db.invitation.upsert({
    where: {
      organizationId_email: {
        organizationId: ctx.organizationId,
        email,
      },
    },
    create: {
      organizationId: ctx.organizationId,
      email,
      role,
      departmentId,
      token,
      status: 'PENDING',
      invitedBy: ctx.user.id,
      expiresAt,
    },
    update: {
      role,
      departmentId,
      token,
      status: 'PENDING',
      invitedBy: ctx.user.id,
      expiresAt,
      acceptedAt: null,
    },
  })

  const appUrl =
    process.env.NEXTAUTH_URL ||
    process.env.APP_URL

  if (!appUrl) {
    await db.invitation.update({
      where: { id: invitation.id },
      data: { status: 'REVOKED' },
    })

    throw new ApiError(
      500,
      'APP_URL_MISSING',
      'Application URL is not configured.'
    )
  }

  const invitationUrl = new URL('/accept-invitation', appUrl)
  invitationUrl.searchParams.set('token', token)

  try {
    await sendInvitationEmail({
      email,
      organizationName: organization.name,
      role,
      invitationUrl: invitationUrl.toString(),
    })
  } catch (error) {
    await db.invitation.update({
      where: { id: invitation.id },
      data: { status: 'REVOKED' },
    })

    console.error('Staff invitation email failed:', error)

    throw new ApiError(
      502,
      'INVITATION_EMAIL_FAILED',
      'Could not send the invitation email. Please try again.'
    )
  }

  return jsonOk({
    message: 'Invitation sent successfully.',
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    },
  })
})