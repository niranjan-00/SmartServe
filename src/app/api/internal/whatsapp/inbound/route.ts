import { safeEqual } from '@/server/crypto'
import { processBaileysInbound } from '@/server/services/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const MAX_TEXT_LENGTH = 10_000

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

type JsonObject = Record<string, unknown>

function errorResponse(message: string, status: number) {
  return Response.json(
    { success: false, error: message },
    {
      status,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: unknown, maxLength = 1000): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result && result.length <= maxLength ? result : null
}

function getOptionalBoolean(value: unknown, fieldName: string): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new Error(`Invalid ${fieldName}`)
  return value
}

async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) throw new Error('EMPTY_BODY')

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

  return new TextDecoder('utf-8', { fatal: true }).decode(combined)
}

/**
 * Validate Base64 strictly and enforce the decoded attachment limit.
 * The current processBaileysInbound service contract does not persist
 * mediaBase64 yet; this validation prevents malformed/oversized payloads
 * while the message metadata is still accepted by the inbound pipeline.
 */
function validateBase64(value: unknown): {
  valid: boolean
  mediaSize?: number
  error?: string
} {
  if (value === undefined || value === null) return { valid: true }

  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, error: 'Media content must be a non-empty Base64 string' }
  }

  const maxBase64Length = Math.ceil(MAX_MEDIA_BYTES / 3) * 4
  if (value.length > maxBase64Length) {
    return { valid: false, error: 'Media exceeds the 10 MB limit' }
  }

  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return { valid: false, error: 'Invalid Base64 media content' }
  }

  const buffer = Buffer.from(value, 'base64')
  if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
    return { valid: false, error: 'Media is empty or exceeds the 10 MB limit' }
  }

  if (buffer.toString('base64') !== value) {
    return { valid: false, error: 'Invalid Base64 encoding' }
  }

  return { valid: true, mediaSize: buffer.length }
}

function normalizeMimeType(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const raw = getString(value, 150)
  if (!raw) return null

  const mime = raw.split(';', 1)[0].trim().toLowerCase()
  // Accept valid MIME types instead of maintaining a short allow-list that
  // can reject otherwise legitimate WhatsApp attachments.
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return null
  return mime
}

export async function POST(req: Request) {
  // 1. Authenticate the worker before reading/parsing its body.
  const expectedSecret = process.env.WHATSAPP_WORKER_SECRET
  const suppliedSecret = req.headers.get('x-worker-secret')

  if (
    !expectedSecret ||
    !suppliedSecret ||
    !safeEqual(expectedSecret, suppliedSecret)
  ) {
    return errorResponse('Unauthorized worker request', 401)
  }

  // 2. Require JSON.
  const contentType = req.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return errorResponse('Content-Type must be application/json', 415)
  }

  // 3. Enforce Content-Length when supplied, then enforce the streamed limit.
  const contentLengthHeader = req.headers.get('content-length')
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader)
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return errorResponse('Invalid Content-Length header', 400)
    }
    if (contentLength > MAX_BODY_BYTES) {
      return errorResponse('Inbound request exceeds the 15 MB limit', 413)
    }
  }

  let rawBody: string
  try {
    rawBody = await readBodyWithLimit(req, MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof Error && error.message === 'BODY_TOO_LARGE') {
      return errorResponse('Inbound request exceeds the 15 MB limit', 413)
    }
    return errorResponse('Unable to read request body', 400)
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return errorResponse('Invalid JSON payload', 400)
  }

  if (!isObject(payload)) {
    return errorResponse('Invalid inbound message payload', 400)
  }

  // 4. Validate identifiers and timestamp.
  const accountId = getString(payload.accountId, 128)
  const from = getString(payload.from, 30)
  const whatsappMessageId = getString(payload.whatsappMessageId, 200)
  const timestamp = getString(payload.timestamp, 100)

  if (!accountId || !from || !whatsappMessageId || !timestamp) {
    return errorResponse(
      'Missing accountId, from, whatsappMessageId or timestamp',
      400,
    )
  }

  // The service stores customers by phone number. Do not silently accept
  // LIDs/JIDs here: the worker must resolve them to a phone number first.
  if (!/^\d{6,20}$/.test(from)) {
    return errorResponse('Invalid customer WhatsApp phone number', 400)
  }

  const parsedTimestamp = new Date(timestamp)
  if (Number.isNaN(parsedTimestamp.getTime())) {
    return errorResponse('Invalid message timestamp', 400)
  }

  // 5. Validate message type and text.
  const messageType = String(payload.messageType ?? 'TEXT').trim().toUpperCase()
  if (!ALLOWED_MESSAGE_TYPES.has(messageType)) {
    return errorResponse(`Unsupported message type: ${messageType}`, 400)
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (text.length > MAX_TEXT_LENGTH) {
    return errorResponse('Message text exceeds the 10,000 character limit', 400)
  }

  const profileName =
    payload.profileName == null ? null : getString(payload.profileName, 150)
  if (payload.profileName != null && !profileName) {
    return errorResponse('Invalid WhatsApp profile name', 400)
  }

  // 6. Validate attachment metadata without rejecting new valid MIME types.
  const mediaMimeType = normalizeMimeType(payload.mediaMimeType)
  if (payload.mediaMimeType != null && !mediaMimeType) {
    return errorResponse('Invalid media MIME type', 400)
  }

  const mediaFileName =
    payload.mediaFileName == null ? null : getString(payload.mediaFileName, 255)
  if (payload.mediaFileName != null && !mediaFileName) {
    return errorResponse('Invalid media file name', 400)
  }

  const mediaValidation = validateBase64(payload.mediaBase64)
  if (!mediaValidation.valid) {
    return errorResponse(mediaValidation.error || 'Invalid media content', 400)
  }

  const hasMedia = payload.mediaBase64 !== undefined && payload.mediaBase64 !== null

  if (hasMedia && !mediaMimeType) {
    return errorResponse(
      'Media MIME type is required when media content is provided',
      400,
    )
  }

  if (hasMedia && !MEDIA_MESSAGE_TYPES.has(messageType)) {
    return errorResponse('Media content does not match the message type', 400)
  }

  const mediaDownloadError =
    payload.mediaDownloadError == null
      ? null
      : getString(payload.mediaDownloadError, 300)

  if (payload.mediaDownloadError != null && !mediaDownloadError) {
    return errorResponse('Invalid media download error metadata', 400)
  }

  let isVoiceNote: boolean | null
  let isViewOnce: boolean | null
  try {
    isVoiceNote = getOptionalBoolean(payload.isVoiceNote, 'isVoiceNote')
    isViewOnce = getOptionalBoolean(payload.isViewOnce, 'isViewOnce')
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Invalid media flags',
      400,
    )
  }

  if (
    isVoiceNote === true &&
    messageType !== 'AUDIO' &&
    messageType !== 'VOICE_NOTE'
  ) {
    return errorResponse('Voice note flag is only valid for audio messages', 400)
  }

  // 7. Call the existing service using its actual supported contract.
  // Do not cast extra media fields into the service: its current implementation
  // accepts mediaMimeType, but does not yet persist mediaBase64/mediaUrl.
  try {
    const result = await processBaileysInbound({
      accountId,
      from,
      profileName,
      whatsappMessageId,
      timestamp: parsedTimestamp.toISOString(),
      messageType,
      text,
      mediaMimeType,
    })

    const duplicate =
      isObject(result) && result.duplicate === true

    return Response.json(
      {
        success: true,
        accepted: true,
        duplicate,
        accountId,
        whatsappMessageId,
        messageType,
        hasText: Boolean(text),
        hasMedia,
        mediaSize: mediaValidation.mediaSize ?? 0,
        mediaDownloadFailed: Boolean(mediaDownloadError),
        isVoiceNote: isVoiceNote ?? false,
        isViewOnce: isViewOnce ?? false,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  } catch (error) {
    console.error('[WhatsApp Inbound] Processing failed:', {
      accountId,
      whatsappMessageId,
      error: error instanceof Error ? error.message : String(error),
    })

    return errorResponse('Inbound message processing failed', 500)
  }
}
