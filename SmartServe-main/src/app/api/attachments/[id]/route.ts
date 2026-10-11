import { db } from '@/lib/db'
import { withApi, jsonOk } from '@/server/api'
import { requireOrganization } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { getStorage } from '@/server/services/storage'

interface Ctx { params: { id: string } }

/**
 * GET /api/attachments/[id] — secure download (spec §36).
 * Org-scoped authorization before any bytes leave storage; staff can only
 * access attachments of complaints assigned to them.
 */
export const GET = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  const attachment = await db.complaintAttachment.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
    include: { complaint: { select: { assignedTo: true } } },
  })
  if (!attachment) throw ApiError.notFound('Attachment not found')
  if (ctx.role === 'STAFF' && attachment.complaint.assignedTo !== ctx.user.id) {
    throw ApiError.forbidden()
  }

  const storage = getStorage()
  const buffer = await storage.get(attachment.storageKey)
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': attachment.mimeType,
      'content-disposition': `inline; filename="${attachment.fileName.replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=300',
    },
  })
})
