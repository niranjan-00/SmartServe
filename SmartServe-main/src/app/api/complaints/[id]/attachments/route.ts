import { db } from '@/lib/db'
import { withApi, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { ApiError } from '@/server/errors'
import { validateFileMeta, buildStorageKey, getStorage } from '@/server/services/storage'
import { recordAudit } from '@/server/audit'
import { emitToOrganization } from '@/server/realtime'

interface Ctx { params: { id: string } }

/**
 * POST /api/complaints/[id]/attachments — multipart upload (spec §36).
 * Metadata → DB, bytes → storage adapter. Type/size validated server-side.
 */
export const POST = withApi<Ctx>(async (req, { params }) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'complaints:attach')

  const complaint = await db.complaint.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
  })
  if (!complaint) throw ApiError.notFound('Complaint not found')

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    throw ApiError.badRequest('Expected multipart/form-data upload')
  }
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('A file field is required')

  validateFileMeta(file.name, file.type, file.size)

  const buffer = Buffer.from(await file.arrayBuffer())
  const storageKey = buildStorageKey(ctx.organizationId, params.id, file.name)
  const storage = getStorage()
  try {
    await storage.put(storageKey, buffer)
  } catch {
    throw ApiError.serviceUnavailable('File storage')
  }

  const attachment = await db.complaintAttachment.create({
    data: {
      organizationId: ctx.organizationId,
      complaintId: params.id,
      uploadedBy: ctx.user.id,
      fileName: file.name.slice(0, 255),
      mimeType: file.type,
      size: file.size,
      storageKey,
    },
  })

  await recordAudit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: 'attachment.uploaded',
    entityType: 'ComplaintAttachment',
    entityId: attachment.id,
    newValue: { fileName: file.name, complaintId: params.id },
  })
  await emitToOrganization(ctx.organizationId, 'complaint.updated', { complaintId: params.id })

  return jsonOk({
    attachment: {
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      createdAt: attachment.createdAt,
    },
  }, { status: 201 })
})

/** GET: attachment metadata list. */
export const GET = withApi<Ctx>(async (_req, { params }) => {
  const ctx = await requireOrganization()
  const complaint = await db.complaint.findFirst({
    where: { id: params.id, organizationId: ctx.organizationId },
    include: { attachments: { orderBy: { createdAt: 'asc' } } },
  })
  if (!complaint) throw ApiError.notFound('Complaint not found')
  return jsonOk({
    attachments: complaint.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
      createdAt: a.createdAt,
    })),
  })
})
