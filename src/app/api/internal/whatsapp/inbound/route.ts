
import { safeEqual } from '@/server/crypto'
import { processBaileysInbound } from '@/server/services/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 10 * 1024 * 1024

const ALLOWED_MESSAGE_TYPES = new Set([
  'TEXT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'VOICE_NOTE',
  'DOCUMENT',
  'STICKER',
  'LOCATION',
  'CONTACT',
  'INTERACTIVE',
])

const MEDIA_MESSAGE_TYPES = new Set([
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'VOICE_NOTE',
  'DOCUMENT',
  'STICKER',
])

const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'audio/opus',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
])

type JsonObject = Record<string, unknown>

function errorResponse(message: string, status: number) {
  return Response.json(
    {
      success: false,
      error: message,
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}

function isObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function getString(
  value: unknown,
  maxLength = 1000,
): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const result = value.trim()

  if (!result || result.length > maxLength) {
    return null
  }

  return result
}

function getOptionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | null {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${fieldName}`)
  }

  return value
}

/**
 * Read the request body with a hard byte limit.
 * This also protects requests that do not provide Content-Length.
 */
async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<string> {
  if (!req.body) {
    throw new Error('Request body is empty')
  }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      if (!value) continue

      totalBytes += value.byteLength

      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new Error('BODY_TOO_LARGE')
      }

      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const combined = new Uint8Array(totalBytes)
  let offset = 0

  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder('utf-8', {
    fatal: true,
  }).decode(combined)
}

/**
 * Validate Base64 without accepting malformed or oversized data.
 */
function validateBase64(value: unknown): {
  valid: boolean
  mediaBase64?: string
  mediaSize?: number
  error?: string
} {
  if (value === undefined || value === null) {
    return { valid: true }
  }

  if (typeof value !== 'string' || !value.length) {
    return {
      valid: false,
      error: 'Media content must be a non-empty Base64 string',
    }
  }

  const maxBase64Length =
    Math.ceil(MAX_MEDIA_BYTES / 3) * 4

  if (value.length > maxBase64Length) {
    return {
      valid: false,
      error: 'Media exceeds the 10 MB limit',
    }
  }

  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return {
      valid: false,
      error: 'Invalid Base64 media content',
    }
  }

  const buffer = Buffer.from(value, 'base64')

  if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
    return {
      valid: false,
      error: 'Media is empty or exceeds the 10 MB limit',
    }
  }

  if (buffer.toString('base64') !== value) {
    return {
      valid: false,
      error: 'Invalid Base64 encoding',
    }
  }

  return {
    valid: true,
    mediaBase64: value,
    mediaSize: buffer.length,
  }
}

export async function POST(req: Request) {
  // ---------------------------------------------------------
  // 1. AUTHENTICATE THE BAILEYS WORKER
  // ---------------------------------------------------------

  const expectedSecret =
    process.env.WHATSAPP_WORKER_SECRET

  const suppliedSecret =
    req.headers.get('x-worker-secret')

  if (
    !expectedSecret ||
    !suppliedSecret ||
    !safeEqual(expectedSecret, suppliedSecret)
  ) {
    return errorResponse(
      'Unauthorized worker request',
      401,
    )
  }

  // ---------------------------------------------------------
  // 2. VALIDATE CONTENT TYPE
  // ---------------------------------------------------------

  const contentType =
    req.headers.get('content-type') || ''

  if (
    !contentType
      .toLowerCase()
      .includes('application/json')
  ) {
    return errorResponse(
      'Content-Type must be application/json',
      415,
    )
  }

  // ---------------------------------------------------------
  // 3. CHECK CONTENT LENGTH
  // ---------------------------------------------------------

  const contentLengthHeader =
    req.headers.get('content-length')

  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader)

    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0
    ) {
      return errorResponse(
        'Invalid Content-Length header',
        400,
      )
    }

    if (contentLength > MAX_BODY_BYTES) {
      return errorResponse(
        'Inbound request exceeds the 15 MB limit',
        413,
      )
    }
  }

  // ---------------------------------------------------------
  // 4. READ BODY WITH A HARD SIZE LIMIT
  // ---------------------------------------------------------

  let rawBody: string

  try {
    rawBody = await readBodyWithLimit(
      req,
      MAX_BODY_BYTES,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'BODY_TOO_LARGE'
    ) {
      return errorResponse(
        'Inbound request exceeds the 15 MB limit',
        413,
      )
    }

    return errorResponse(
      'Unable to read request body',
      400,
    )
  }

  // ---------------------------------------------------------
  // 5. PARSE JSON
  // ---------------------------------------------------------

  let payload: unknown

  try {
    payload = JSON.parse(rawBody)
  } catch {
    return errorResponse(
      'Invalid JSON payload',
      400,
    )
  }

  if (!isObject(payload)) {
    return errorResponse(
      'Invalid inbound message payload',
      400,
    )
  }

  // ---------------------------------------------------------
  // 6. VALIDATE REQUIRED FIELDS
  // ---------------------------------------------------------

  const accountId =
    getString(payload.accountId, 128)

  const from =
    getString(payload.from, 30)

  const whatsappMessageId =
    getString(payload.whatsappMessageId, 200)

  const timestamp =
    getString(payload.timestamp, 100)

  if (
    !accountId ||
    !from ||
    !whatsappMessageId ||
    !timestamp
  ) {
    return errorResponse(
      'Missing accountId, from, whatsappMessageId or timestamp',
      400,
    )
  }

  // Only accept a resolved WhatsApp phone number.
  if (!/^\d{6,20}$/.test(from)) {
    return errorResponse(
      'Invalid customer WhatsApp phone number',
      400,
    )
  }

  const parsedTimestamp = new Date(timestamp)

  if (Number.isNaN(parsedTimestamp.getTime())) {
    return errorResponse(
      'Invalid message timestamp',
      400,
    )
  }

  // ---------------------------------------------------------
  // 7. VALIDATE MESSAGE TYPE
  // ---------------------------------------------------------

  const messageType = String(
    payload.messageType || 'TEXT',
  ).trim().toUpperCase()

  if (!ALLOWED_MESSAGE_TYPES.has(messageType)) {
    return errorResponse(
      `Unsupported message type: ${messageType}`,
      400,
    )
  }

  // ---------------------------------------------------------
  // 8. VALIDATE TEXT AND PROFILE NAME
  // ---------------------------------------------------------

  const text =
    typeof payload.text === 'string'
      ? payload.text.trim()
      : ''

  if (text.length > 10000) {
    return errorResponse(
      'Message text exceeds the 10,000 character limit',
      400,
    )
  }

  const profileName =
    payload.profileName == null
      ? null
      : getString(payload.profileName, 150)

  if (
    payload.profileName != null &&
    !profileName
  ) {
    return errorResponse(
      'Invalid WhatsApp profile name',
      400,
    )
  }

  // ---------------------------------------------------------
  // 9. VALIDATE MEDIA METADATA
  // ---------------------------------------------------------

  const mediaMimeType =
    payload.mediaMimeType == null
      ? null
      : getString(payload.mediaMimeType, 150)

  const mediaFileName =
    payload.mediaFileName == null
      ? null
      : getString(payload.mediaFileName, 255)

  if (
    payload.mediaMimeType != null &&
    !mediaMimeType
  ) {
    return errorResponse(
      'Invalid media MIME type',
      400,
    )
  }

  if (
    payload.mediaFileName != null &&
    !mediaFileName
  ) {
    return errorResponse(
      'Invalid media file name',
      400,
    )
  }

  const normalizedMimeType =
    mediaMimeType
      ?.split(';')[0]
      .trim()
      .toLowerCase() || null

  if (
    normalizedMimeType &&
    !ALLOWED_MEDIA_TYPES.has(normalizedMimeType)
  ) {
    return errorResponse(
      `Unsupported media format: ${normalizedMimeType}`,
      415,
    )
  }

  // ---------------------------------------------------------
  // 10. VALIDATE MEDIA CONTENT
  // ---------------------------------------------------------

  const mediaValidation = validateBase64(
    payload.mediaBase64,
  )

  if (!mediaValidation.valid) {
    return errorResponse(
      mediaValidation.error || 'Invalid media content',
      400,
    )
  }

  const mediaBase64 =
    mediaValidation.mediaBase64

  const mediaSize =
    mediaValidation.mediaSize

  if (mediaBase64 && !normalizedMimeType) {
    return errorResponse(
      'Media MIME type is required when media content is provided',
      400,
    )
  }

  if (
    mediaBase64 &&
    !MEDIA_MESSAGE_TYPES.has(messageType)
  ) {
    return errorResponse(
      'Media content does not match the message type',
      400,
    )
  }

  if (
    MEDIA_MESSAGE_TYPES.has(messageType) &&
    !mediaBase64 &&
    !payload.mediaDownloadError
  ) {
    // A media download can fail at the worker.
    // Do not reject the original WhatsApp message just because
    // its attachment could not be downloaded.
  }

  // ---------------------------------------------------------
  // 11. VALIDATE MEDIA DOWNLOAD ERROR
  // ---------------------------------------------------------

  const mediaDownloadError =
    payload.mediaDownloadError == null
      ? null
      : getString(payload.mediaDownloadError, 300)

  if (
    payload.mediaDownloadError != null &&
    !mediaDownloadError
  ) {
    return errorResponse(
      'Invalid media download error metadata',
      400,
    )
  }

  // ---------------------------------------------------------
  // 12. VALIDATE VOICE NOTE AND VIEW-ONCE FLAGS
  // ---------------------------------------------------------

  let isVoiceNote: boolean | null
  let isViewOnce: boolean | null

  try {
    isVoiceNote = getOptionalBoolean(
      payload.isVoiceNote,
      'isVoiceNote',
    )

    isViewOnce = getOptionalBoolean(
      payload.isViewOnce,
      'isViewOnce',
    )
  } catch (error) {
    return errorResponse(
      error instanceof Error
        ? error.message
        : 'Invalid media flags',
      400,
    )
  }

  if (
    isVoiceNote &&
    !['AUDIO', 'VOICE_NOTE'].includes(messageType)
  ) {
    return errorResponse(
      'Voice note flag is only valid for audio messages',
      400,
    )
  }

  // ---------------------------------------------------------
  // 13. BUILD THE SERVICE PAYLOAD
  // ---------------------------------------------------------

  const inboundPayload = {
    accountId,
    from,
    profileName,
    whatsappMessageId,
    timestamp: parsedTimestamp.toISOString(),
    messageType,
    text,

    mediaMimeType: normalizedMimeType,
    mediaFileName: mediaFileName || undefined,
    mediaBase64,
    mediaSize,

    mediaDownloadError:
      mediaDownloadError || undefined,

    isVoiceNote: isVoiceNote ?? false,
    isViewOnce: isViewOnce ?? false,
  }

  // ---------------------------------------------------------
  // 14. PROCESS INBOUND MESSAGE
  // ---------------------------------------------------------

  try {
    /*
     * The additional media properties are forwarded to the
     * WhatsApp service. The current service implementation
     * must be extended to persist media bytes and set Message.mediaUrl.
     */
    const result = await processBaileysInbound(
      inboundPayload as Parameters<
        typeof processBaileysInbound
      >[0],
    )

    return Response.json(
      {
        success: true,
        accepted: true,
        duplicate:
          isObject(result) &&
          result.duplicate === true,

        accountId,
        whatsappMessageId,
        messageType,

        hasText: Boolean(text),
        hasMedia: Boolean(mediaBase64),
        mediaSize: mediaSize ?? 0,
        mediaDownloadFailed:
          Boolean(mediaDownloadError),

        isVoiceNote: isVoiceNote ?? false,
        isViewOnce: isViewOnce ?? false,

        ...(isObject(result) ? result : { result }),
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  } catch (error) {
    console.error(
      '[WhatsApp Inbound] Processing failed:',
      {
        accountId,
        whatsappMessageId,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
    )

    return errorResponse(
      'Inbound message processing failed',
      500,
    )
  }
}