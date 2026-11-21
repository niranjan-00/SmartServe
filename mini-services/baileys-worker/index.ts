
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'

import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
} from '@whiskeysockets/baileys'

import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import pino from 'pino'

import { db } from '../../src/lib/db'
import {
  decryptSecret,
  encryptSecret,
  safeEqual,
} from '../../src/server/crypto'

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(
  process.env.PORT ||
  process.env.WHATSAPP_WORKER_PORT ||
  3020,
)

const SECRET = process.env.WHATSAPP_WORKER_SECRET || ''

const APP_URL = (
  process.env.NEXT_APP_URL ||
  (process.env.NODE_ENV === 'production'
    ? ''
    : 'http://localhost:3000')
).replace(/\/$/, '')

const MAX_MEDIA_BYTES = Number(
  process.env.WHATSAPP_MAX_MEDIA_BYTES ||
  10 * 1024 * 1024,
)

const MAX_REQUEST_BYTES = 15 * 1024 * 1024
const MAX_TEXT_LENGTH = 10000

const MAX_FORWARD_ATTEMPTS = 5
const RECONNECT_DELAY_MS = 5000

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
})

type Socket = ReturnType<typeof makeWASocket>

const sockets = new Map<string, Socket>()

const starting = new Set<string>()

// Prevent automatic reconnect after an operator disconnects an account.
const manuallyStopped = new Set<string>()
const reconnectAttempts = new Map<string, number>()

const reconnectTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>()

const qrCache = new Map<
  string,
  {
    dataUrl: string
    expiresAt: number
  }
>()

// Each WhatsApp account gets its own sequential queue.
const incomingQueues = new Map<string, Promise<void>>()

// Prevent duplicate processing while an event is queued.
const queuedMessageIds = new Set<string>()

let shuttingDown = false

if (!SECRET) {
  throw new Error('WHATSAPP_WORKER_SECRET is required')
}

if (!APP_URL) {
  throw new Error('NEXT_APP_URL is required in production')
}

if (
  !Number.isFinite(MAX_MEDIA_BYTES) ||
  MAX_MEDIA_BYTES < 1024 ||
  MAX_MEDIA_BYTES > 20 * 1024 * 1024
) {
  throw new Error(
    'WHATSAPP_MAX_MEDIA_BYTES must be between 1 KB and 20 MB',
  )
}

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.AUTH_SECRET ||
    process.env.AUTH_SECRET.length < 32)
) {
  throw new Error(
    'AUTH_SECRET must contain at least 32 characters in production',
  )
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

function authorized(req: IncomingMessage): boolean {
  const supplied = String(
    req.headers['x-worker-secret'] || '',
  )

  return Boolean(
    supplied && safeEqual(supplied, SECRET),
  )
}

function json(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  if (res.headersSent || res.destroyed) return

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })

  res.end(JSON.stringify(data))
}

async function readBody(
  req: IncomingMessage,
): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)

    total += buffer.length

    if (total > MAX_REQUEST_BYTES) {
      throw new Error(
        'Request body exceeds the allowed size',
      )
    }

    chunks.push(buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8')

  try {
    return JSON.parse(raw || '{}')
  } catch {
    throw new Error('Invalid JSON request body')
  }
}

async function setStatus(
  accountId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.whatsAppAccount.updateMany({
    where: { id: accountId },
    data: {
      status,
      ...extra,
    },
  })
}

function clearReconnectTimer(accountId: string): void {
  const timer = reconnectTimers.get(accountId)

  if (timer) {
    clearTimeout(timer)
    reconnectTimers.delete(accountId)
  }
}

function scheduleReconnect(accountId: string): void {
  if (shuttingDown || manuallyStopped.has(accountId) || reconnectTimers.has(accountId)) return

  const attempt = (reconnectAttempts.get(accountId) || 0) + 1
  reconnectAttempts.set(accountId, attempt)
  const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(2, attempt - 1), 60000)

  const timer = setTimeout(() => {
    reconnectTimers.delete(accountId)
    if (shuttingDown || manuallyStopped.has(accountId)) return

    void startSession(accountId).catch((error) => {
      logger.error({ accountId, attempt, error: getErrorMessage(error) }, 'WhatsApp reconnection failed')
      scheduleReconnect(accountId)
    })
  }, delay)

  reconnectTimers.set(accountId, timer)
  logger.info({ accountId, attempt, delay }, 'WhatsApp reconnection scheduled')
}

function normalizePhoneNumber(
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null

  const digits = value.replace(/\D/g, '')

  if (digits.length < 6 || digits.length > 20) {
    return null
  }

  return digits
}

function normalizeCustomerJid(
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null

  const candidate = value.trim()

  if (
    /^\d{6,20}@s\.whatsapp\.net$/.test(candidate)
  ) {
    return candidate
  }

  if (/^\d{6,20}$/.test(candidate)) {
    return `${candidate}@s.whatsapp.net`
  }

  return null
}

function toJid(phone: string): string {
  return `${phone}@s.whatsapp.net`
}

function firstNonEmpty(
  ...values: unknown[]
): string {
  for (const value of values) {
    if (
      typeof value === 'string' &&
      value.trim()
    ) {
      return value.trim()
    }
  }

  return ''
}

// ============================================================
// ENCRYPTED BAILEYS AUTHENTICATION
// ============================================================

function createAuthState(
  accountId: string,
  storedCreds: string | null,
) {
  const creds = storedCreds
    ? JSON.parse(
        decryptSecret(storedCreds),
        BufferJSON.reviver,
      )
    : initAuthCreds()

  const keys = {
    get: async (
      type: string,
      ids: string[],
    ): Promise<Record<string, unknown>> => {
      if (!ids.length) return {}

      const rows = await db.whatsAppAuthKey.findMany({
        where: {
          accountId,
          keyId: {
            in: ids.map((id) => `${type}:${id}`),
          },
        },
      })

      const result: Record<string, unknown> = {}

      for (const row of rows) {
        const id = row.keyId.slice(type.length + 1)

        let value = JSON.parse(
          decryptSecret(row.value),
          BufferJSON.reviver,
        )

        if (
          type === 'app-state-sync-key' &&
          value
        ) {
          value =
            proto.Message.AppStateSyncKeyData.fromObject(
              value,
            )
        }

        result[id] = value
      }

      return result
    },

    set: async (
      data: Record<
        string,
        Record<string, unknown>
      >,
    ): Promise<void> => {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          const keyId = `${type}:${id}`

          if (value == null) {
            await db.whatsAppAuthKey.deleteMany({
              where: {
                accountId,
                keyId,
              },
            })

            continue
          }

          const encrypted = encryptSecret(
            JSON.stringify(value, BufferJSON.replacer),
          )

          await db.whatsAppAuthKey.upsert({
            where: {
              accountId_keyId: {
                accountId,
                keyId,
              },
            },
            create: {
              accountId,
              keyId,
              value: encrypted,
            },
            update: {
              value: encrypted,
            },
          })
        }
      }
    },

    clear: async (): Promise<void> => {
      await db.whatsAppAuthKey.deleteMany({
        where: { accountId },
      })
    },
  }

  return { creds, keys }
}

// ============================================================
// MESSAGE EXTRACTION
// ============================================================

function unwrapMessage(message: any): any {
  let current = message?.message || {}

  for (let i = 0; i < 20; i++) {
    const wrapper =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.deviceSentMessage?.message

    if (!wrapper) break

    current = wrapper
  }

  return current
}

type ExtractedMessage = {
  text: string
  type: string
  mimeType: string | null
  fileName: string | null
  mediaNode: any | null
  isVoiceNote: boolean
  isViewOnce: boolean
}

function messageText(message: any): ExtractedMessage {
  const m = unwrapMessage(message)

  let type = 'TEXT'
  let mimeType: string | null = null
  let fileName: string | null = null
  let mediaNode: any | null = null
  let isVoiceNote = false

  const isViewOnce = Boolean(
    message?.message?.viewOnceMessage ||
    message?.message?.viewOnceMessageV2 ||
    message?.message?.viewOnceMessageV2Extension,
  )

  if (m.imageMessage) {
    type = 'IMAGE'
    mediaNode = m.imageMessage
    mimeType = m.imageMessage.mimetype || 'image/jpeg'
  } else if (m.videoMessage) {
    type = 'VIDEO'
    mediaNode = m.videoMessage
    mimeType = m.videoMessage.mimetype || 'video/mp4'
  } else if (m.audioMessage) {
    mediaNode = m.audioMessage
    mimeType = m.audioMessage.mimetype || 'audio/ogg'

    isVoiceNote = Boolean(
      m.audioMessage.ptt ||
      m.audioMessage.ptv,
    )

    type = isVoiceNote ? 'VOICE_NOTE' : 'AUDIO'
  } else if (m.documentMessage) {
    type = 'DOCUMENT'
    mediaNode = m.documentMessage
    mimeType =
      m.documentMessage.mimetype ||
      'application/octet-stream'

    fileName = m.documentMessage.fileName || null
  } else if (m.stickerMessage) {
    type = 'STICKER'
    mediaNode = m.stickerMessage
    mimeType = m.stickerMessage.mimetype || 'image/webp'
  } else if (
    m.locationMessage ||
    m.liveLocationMessage
  ) {
    type = 'LOCATION'
  } else if (
    m.contactMessage ||
    m.contactsArrayMessage
  ) {
    type = 'CONTACT'
  } else if (
    m.buttonsResponseMessage ||
    m.listResponseMessage ||
    m.templateButtonReplyMessage ||
    m.interactiveResponseMessage ||
    m.pollUpdateMessage
  ) {
    type = 'INTERACTIVE'
  }

  // Location extraction.
  const location =
    m.locationMessage ||
    m.liveLocationMessage ||
    null

  let locationText = ''

  if (location) {
    const parts: string[] = []

    if (location.name) {
      parts.push(`Place: ${location.name}`)
    }

    if (location.address) {
      parts.push(`Address: ${location.address}`)
    }

    if (
      typeof location.degreesLatitude === 'number' &&
      typeof location.degreesLongitude === 'number'
    ) {
      parts.push(
        `Coordinates: ${location.degreesLatitude}, ${location.degreesLongitude}`,
      )
    }

    locationText =
      parts.join('\n') ||
      'Customer shared their WhatsApp location.'
  }

  // Contact extraction.
  const contact = m.contactMessage || null

  const contactText = contact
    ? [
        contact.displayName
          ? `Contact: ${contact.displayName}`
          : '',
        contact.vcard || '',
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  const contacts = m.contactsArrayMessage?.contacts || []

  const contactsText = contacts
    .map((item: any) =>
      [
        item.displayName || '',
        item.vcard || '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n')

  let text = firstNonEmpty(
    m.conversation,
    m.extendedTextMessage?.text,
    m.imageMessage?.caption,
    m.videoMessage?.caption,
    m.documentMessage?.caption,
    m.buttonsResponseMessage?.selectedDisplayText,
    m.buttonsResponseMessage?.selectedButtonId,
    m.listResponseMessage?.title,
    m.listResponseMessage?.singleSelectReply?.selectedRowId,
    m.templateButtonReplyMessage?.selectedDisplayText,
    m.templateButtonReplyMessage?.selectedId,
    m.interactiveResponseMessage?.body?.text,
    locationText,
    contactText,
    contactsText,
  )

  // Interactive native-flow response.
  if (
    !text &&
    m.interactiveResponseMessage
      ?.nativeFlowResponseMessage?.paramsJson
  ) {
    const paramsJson =
      m.interactiveResponseMessage
        .nativeFlowResponseMessage.paramsJson

    try {
      const params = JSON.parse(paramsJson)

      text = firstNonEmpty(
        params.id,
        params.title,
        params.display_text,
        params.selectedId,
      )
    } catch {
      text = String(paramsJson)
    }
  }

  // Poll response.
  if (!text && m.pollUpdateMessage) {
    text = '[Customer responded to a WhatsApp poll]'
  }

  // Never silently create an empty TEXT message.
  if (!text) {
    const keys = Object.keys(m || {})

    if (type === 'TEXT') {
      type = 'INTERACTIVE'
    }

    text = keys.length
      ? `[WhatsApp message received: ${keys.join(', ')}]`
      : '[WhatsApp message could not be decoded]'
  }

  return {
    text: String(text).trim().slice(0, MAX_TEXT_LENGTH),
    type,
    mimeType,
    fileName,
    mediaNode,
    isVoiceNote,
    isViewOnce,
  }
}

// ============================================================
// MEDIA HELPERS
// ============================================================

function getMediaSize(mediaNode: any): number | null {
  const raw = mediaNode?.fileLength

  if (raw == null) return null

  try {
    const value = Number(raw.toString())

    return Number.isFinite(value) && value >= 0
      ? value
      : null
  } catch {
    return null
  }
}

function safeFileName(
  name: string | null,
  type: string,
  mimeType: string | null,
): string {
  const clean = (name || '')
    .replace(/[^\w.-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 150)

  if (clean) return clean

  const extension =
    mimeType?.includes('png') ? '.png' :
    mimeType?.includes('jpeg') ? '.jpg' :
    mimeType?.includes('webp') ? '.webp' :
    mimeType?.includes('gif') ? '.gif' :
    mimeType?.includes('pdf') ? '.pdf' :
    mimeType?.includes('mp4') ? '.mp4' :
    mimeType?.includes('mpeg') ? '.mp3' :
    mimeType?.includes('ogg') ? '.ogg' :
    mimeType?.includes('opus') ? '.opus' :
    mimeType?.includes('wav') ? '.wav' :
    mimeType?.includes('webm') ? '.webm' :
    ''

  return `${type.toLowerCase()}-${Date.now()}${extension}`
}

function isAllowedMediaMimeType(
  mimeType: string,
): boolean {
  const allowed = [
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
  ]

  return allowed.includes(
    mimeType.split(';')[0].trim().toLowerCase(),
  )
}

async function downloadIncomingMedia(
  sock: Socket,
  message: any,
  extracted: ExtractedMessage,
): Promise<{
  mediaBase64?: string
  mediaFileName?: string
  mediaMimeType?: string
  mediaSize?: number
  mediaDownloadError?: string
}> {
  if (!extracted.mediaNode) return {}

  const mimeType =
    extracted.mimeType || 'application/octet-stream'

  if (!isAllowedMediaMimeType(mimeType)) {
    return {
      mediaDownloadError:
        `Unsupported attachment type: ${mimeType}`,
    }
  }

  const expectedSize = getMediaSize(extracted.mediaNode)

  if (
    expectedSize !== null &&
    expectedSize > MAX_MEDIA_BYTES
  ) {
    return {
      mediaDownloadError:
        `Attachment exceeds the ${MAX_MEDIA_BYTES} byte limit.`,
    }
  }

  try {
    const downloaded = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )

    const buffer = Buffer.isBuffer(downloaded)
      ? downloaded
      : Buffer.from(downloaded as any)

    if (!buffer.length) {
      throw new Error('Downloaded media is empty')
    }

    if (buffer.length > MAX_MEDIA_BYTES) {
      return {
        mediaDownloadError:
          'Attachment exceeds the configured media size limit.',
      }
    }

    return {
      mediaBase64: buffer.toString('base64'),
      mediaFileName: safeFileName(
        extracted.fileName,
        extracted.type,
        mimeType,
      ),
      mediaMimeType: mimeType,
      mediaSize: buffer.length,
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)

    logger.error(
      {
        messageId: message?.key?.id,
        type: extracted.type,
        error: errorMessage,
      },
      'WhatsApp media download failed',
    )

    return {
      mediaDownloadError: errorMessage.slice(0, 300),
    }
  }
}

// ============================================================
// CUSTOMER PHONE NUMBER RESOLUTION
// ============================================================

async function resolveCustomerJid(
  sock: Socket,
  message: any,
  remoteJid: string,
): Promise<string | null> {
  const key = message?.key || {}
  const candidates = [
    key.senderPn,
    key.remoteJidAlt,
    key.participantAlt,
    key.participant,
    message?.senderPn,
    message?.remoteJidAlt,
    remoteJid.endsWith('@s.whatsapp.net') ? remoteJid : null,
  ]

  for (const candidate of candidates) {
    const resolved = normalizeCustomerJid(candidate)
    if (resolved) return resolved
  }

  if (remoteJid.endsWith('@lid')) {
    try {
      const lidMapping = (sock as any)?.signalRepository?.lidMapping
      const mapped = await lidMapping?.getPNForLID?.(remoteJid)
      const resolved = normalizeCustomerJid(mapped)

      if (resolved) {
        logger.info({ remoteJid, resolved }, 'Resolved WhatsApp LID to phone number')
        return resolved
      }
    } catch (error) {
      logger.warn({ remoteJid, error: getErrorMessage(error) }, 'WhatsApp LID resolution failed')
    }
  }

  logger.warn(
    { remoteJid, messageId: key.id, remoteJidAlt: key.remoteJidAlt, senderPn: key.senderPn },
    'Customer phone number is unavailable for this WhatsApp JID',
  )
  return null
}

// ============================================================
// SMARTSERVE INBOUND FORWARDING
// ============================================================

async function notifyInbound(
  payload: Record<string, unknown>,
): Promise<void> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_FORWARD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${APP_URL}/api/internal/whatsapp/inbound`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-worker-secret': SECRET,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
      })

      const responseText = await response.text()

      if (response.ok) {
        let responseData: any = {}
        try {
          responseData = responseText ? JSON.parse(responseText) : {}
        } catch {
          responseData = {}
        }

        if (responseData.success === false) {
          throw new Error(responseData.error || 'SmartServe rejected the incoming message')
        }

        logger.info(
          {
            accountId: payload.accountId,
            messageId: payload.whatsappMessageId,
            attempt: attempt + 1,
            httpStatus: response.status,
          },
          'SmartServe accepted incoming message',
        )
        return
      }

      lastError = new Error(
        `Inbound endpoint returned ${response.status}: ${responseText.slice(0, 500)}`,
      )

      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429
      ) break
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Inbound forwarding failed')

      logger.error(
        {
          accountId: payload.accountId,
          messageId: payload.whatsappMessageId,
          attempt: attempt + 1,
          maxAttempts: MAX_FORWARD_ATTEMPTS,
          error: lastError.message,
        },
        'Inbound forwarding attempt failed',
      )

      if (
        /Inbound endpoint returned 4\d\d/.test(lastError.message) &&
        !/returned 408|returned 429/.test(lastError.message)
      ) break
    }

    if (attempt < MAX_FORWARD_ATTEMPTS - 1) {
      await sleep(Math.min(1000 * Math.pow(2, attempt), 20000))
    }
  }

  throw lastError || new Error('Could not forward inbound message')
}

// ============================================================
// INCOMING MESSAGE PROCESSING
// ============================================================

async function processIncomingMessage(
  accountId: string,
  sock: Socket,
  message: any,
): Promise<void> {
  const key = message?.key || {}
  const remoteJid = key.remoteJid
  const messageId = key.id

  if (!remoteJid || !messageId) {
    logger.warn({ accountId }, 'Message missing remoteJid or message ID')
    return
  }

  if (key.fromMe) return

  if (
    remoteJid.endsWith('@g.us') ||
    remoteJid.endsWith('@broadcast') ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@newsletter')
  ) return

  const customerJid = await resolveCustomerJid(sock, message, remoteJid)

  if (!customerJid) {
    // A LID is not a phone number. Never invent a customer number.
    logger.error(
      {
        accountId,
        remoteJid,
        messageId,
        remoteJidAlt: key.remoteJidAlt,
        senderPn: key.senderPn,
      },
      'Customer phone number could not be resolved; message cannot be forwarded',
    )
    return
  }

  const extracted = messageText(message)
  const media = await downloadIncomingMedia(sock, message, extracted)

  let timestampSeconds = Number(
    message.messageTimestamp || Math.floor(Date.now() / 1000),
  )

  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    timestampSeconds = Math.floor(Date.now() / 1000)
  }

  const timestamp = new Date(timestampSeconds * 1000)
  const from = customerJid.split('@')[0]

  const payload: Record<string, unknown> = {
    accountId,
    from,
    profileName: message.pushName || null,
    whatsappMessageId: messageId,
    timestamp: timestamp.toISOString(),
    messageType: extracted.type,
    text: extracted.text,
    mediaMimeType: media.mediaMimeType || extracted.mimeType,
    mediaFileName: media.mediaFileName,
    mediaBase64: media.mediaBase64,
    mediaSize: media.mediaSize,
    mediaDownloadError: media.mediaDownloadError,
    isVoiceNote: extracted.isVoiceNote,
    isViewOnce: extracted.isViewOnce,
  }

  logger.info(
    {
      accountId,
      from,
      messageId,
      messageType: extracted.type,
      hasText: Boolean(extracted.text),
      hasMedia: Boolean(media.mediaBase64),
      mediaDownloadFailed: Boolean(media.mediaDownloadError),
    },
    'Forwarding customer WhatsApp message',
  )

  // Do not mark as read until SmartServe accepts the message.
  await notifyInbound(payload)

  try {
    await sock.readMessages([key])
    logger.debug({ accountId, messageId }, 'WhatsApp message marked as read')
  } catch (error) {
    logger.warn(
      { accountId, messageId, error: getErrorMessage(error) },
      'Could not mark WhatsApp message as read',
    )
  }
}

// ============================================================
// SEQUENTIAL MESSAGE QUEUE
// ============================================================

function enqueueIncomingMessage(
  accountId: string,
  sock: Socket,
  message: any,
): void {
  const messageId = message?.key?.id

  if (!messageId) {
    logger.warn({ accountId }, 'Cannot enqueue WhatsApp message without an ID')
    return
  }

  const queueKey = `${accountId}:${messageId}`

  if (queuedMessageIds.has(queueKey)) {
    logger.debug({ accountId, messageId }, 'Duplicate message already queued')
    return
  }

  queuedMessageIds.add(queueKey)

  const previous = incomingQueues.get(accountId) || Promise.resolve()

  const next = previous
    .catch((error) => {
      logger.error(
        { accountId, error: getErrorMessage(error) },
        'Previous inbound queue task failed',
      )
    })
    .then(async () => {
      let completed = false
      const maxProcessingAttempts = 3

      for (let attempt = 0; attempt < maxProcessingAttempts; attempt++) {
        try {
          await processIncomingMessage(accountId, sock, message)
          completed = true
          break
        } catch (error) {
          logger.error(
            {
              accountId,
              messageId,
              attempt: attempt + 1,
              maxAttempts: maxProcessingAttempts,
              error: getErrorMessage(error),
            },
            'Incoming message processing failed',
          )

          if (attempt < maxProcessingAttempts - 1) {
            await sleep(Math.min(2000 * Math.pow(2, attempt), 15000))
          }
        }
      }

      if (!completed) {
        logger.error(
          { accountId, messageId },
          'Incoming message failed after all processing retries',
        )
      }
    })
    .finally(() => {
      queuedMessageIds.delete(queueKey)
    })

  incomingQueues.set(accountId, next)

  void next.finally(() => {
    if (incomingQueues.get(accountId) === next) {
      incomingQueues.delete(accountId)
    }
  })
}

// ============================================================
// CONNECTION STARTUP
// ============================================================

async function startSession(
  accountId: string,
): Promise<void> {
  if (shuttingDown) return

  manuallyStopped.delete(accountId)

  if (
    sockets.has(accountId) ||
    starting.has(accountId)
  ) {
    return
  }

  starting.add(accountId)

  let sock: Socket | null = null

  try {
    const account = await db.whatsAppAccount.findUnique({
      where: { id: accountId },
    })

    if (!account) {
      throw new Error('WhatsApp account not found')
    }

    clearReconnectTimer(accountId)

    await setStatus(accountId, 'CONNECTING', {
      lastError: null,
    })

    const auth = createAuthState(
      accountId,
      account.credsEncrypted,
    )

    sock = makeWASocket({
      auth: {
        creds: auth.creds,
        keys: makeCacheableSignalKeyStore(
          auth.keys as any,
          logger,
        ),
      },

      logger: logger.child({ accountId }),

      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,

      getMessage: async () => undefined,
    })

    sockets.set(accountId, sock)

    // --------------------------------------------------------
    // SAVE AUTHENTICATION CREDENTIALS
    // --------------------------------------------------------

    sock.ev.on('creds.update', async () => {
      try {
        await db.whatsAppAccount.update({
          where: { id: accountId },
          data: {
            credsEncrypted: encryptSecret(
              JSON.stringify(
                auth.creds,
                BufferJSON.replacer,
              ),
            ),
          },
        })
      } catch (error) {
        logger.error(
          {
            accountId,
            error: getErrorMessage(error),
          },
          'Could not save WhatsApp credentials',
        )
      }
    })

    // --------------------------------------------------------
    // CONNECTION STATUS AND QR
    // --------------------------------------------------------

    sock.ev.on(
      'connection.update',
      async ({
        connection,
        qr,
        lastDisconnect,
      }: any) => {
        try {
          if (qr) {
            const dataUrl = await QRCode.toDataURL(qr, {
              width: 280,
              margin: 2,
            })

            qrCache.set(accountId, {
              dataUrl,
              expiresAt: Date.now() + 55000,
            })

            await setStatus(accountId, 'QR_PENDING', {
              lastError: null,
            })

            logger.info(
              { accountId },
              'New WhatsApp QR generated',
            )
          }

          if (connection === 'open') {
            qrCache.delete(accountId)
            clearReconnectTimer(accountId)
            reconnectAttempts.delete(accountId)

            const rawJid = sock?.user?.id || ''

            const phoneNumber =
              rawJid
                .split(':')[0]
                .split('@')[0]
                .replace(/\D/g, '') || null

            await setStatus(accountId, 'CONNECTED', {
              phoneNumber,
              lastConnectedAt: new Date(),
              lastError: null,
            })

            logger.info(
              { accountId, phoneNumber },
              'WhatsApp connection established',
            )
          }

          if (connection === 'close') {
            if (sockets.get(accountId) === sock) {
              sockets.delete(accountId)
            }

            qrCache.delete(accountId)

            const code = (
              lastDisconnect?.error as Boom
            )?.output?.statusCode

            const loggedOut =
              code === DisconnectReason.loggedOut

            await setStatus(
              accountId,
              loggedOut
                ? 'LOGGED_OUT'
                : 'DISCONNECTED',
              {
                lastError: loggedOut
                  ? 'WhatsApp logged out this linked device. Connect again using a new QR code.'
                  : `WhatsApp connection closed (${code ?? 'unknown'}). Reconnecting.`,

                ...(loggedOut
                  ? {
                      credsEncrypted: null,
                      phoneNumber: null,
                    }
                  : {}),
              },
            )

            logger.warn(
              { accountId, code, loggedOut },
              'WhatsApp connection closed',
            )

            if (loggedOut) {
              manuallyStopped.add(accountId)
              reconnectAttempts.delete(accountId)
              await db.whatsAppAuthKey.deleteMany({
                where: { accountId },
              })
            } else if (!manuallyStopped.has(accountId)) {
              scheduleReconnect(accountId)
            }
          }
        } catch (error) {
          logger.error(
            {
              accountId,
              error: getErrorMessage(error),
            },
            'Connection status update failed',
          )
        }
      },
    )

    // --------------------------------------------------------
    // INCOMING WHATSAPP MESSAGES
    // --------------------------------------------------------

    sock.ev.on(
      'messages.upsert',
      ({ messages, type }: any) => {
        if (type !== 'notify') return

        if (
          !Array.isArray(messages) ||
          messages.length === 0
        ) {
          return
        }

        logger.info(
          {
            accountId,
            eventType: type,
            messageCount: messages.length,
          },
          'WhatsApp incoming message batch received',
        )

        for (const message of messages) {
          if (
            !message?.key?.id ||
            !message?.key?.remoteJid
          ) {
            logger.warn(
              { accountId },
              'Skipping malformed WhatsApp message',
            )
            continue
          }

          enqueueIncomingMessage(
            accountId,
            sock!,
            message,
          )
        }
      },
    )

    // --------------------------------------------------------
    // MESSAGE DELIVERY AND READ RECEIPTS
    // --------------------------------------------------------

    sock.ev.on(
      'messages.update',
      async (updates: any[]) => {
        const statusMap: Record<number, string> = {
          0: 'PENDING',
          1: 'SENT',
          2: 'SENT',
          3: 'DELIVERED',
          4: 'READ',
          5: 'READ',
        }

        for (const update of updates || []) {
          try {
            const messageId = update.key?.id

            const status =
              statusMap[
                Number(update.update?.status)
              ]

            if (!messageId || !status) continue

            await db.message.updateMany({
              where: {
                whatsappMessageId: messageId,
              },
              data: { status },
            })

            logger.debug(
              {
                accountId,
                messageId,
                status,
              },
              'WhatsApp message status updated',
            )
          } catch (error) {
            logger.error(
              {
                accountId,
                error: getErrorMessage(error),
              },
              'Could not update delivery status',
            )
          }
        }
      },
    )

  } catch (error) {
    if (
      sock &&
      sockets.get(accountId) === sock
    ) {
      sockets.delete(accountId)

      try {
        sock.end(undefined)
      } catch {
        // Socket may already be closed.
      }
    }

    await setStatus(accountId, 'ERROR', {
      lastError: getErrorMessage(error),
    }).catch(() => undefined)

    throw error
  } finally {
    starting.delete(accountId)
  }
}

// ============================================================
// STOP SESSION
// ============================================================

async function stopSession(
  accountId: string,
  logout = false,
): Promise<void> {
  clearReconnectTimer(accountId)
  manuallyStopped.add(accountId)
  reconnectAttempts.delete(accountId)

  const sock = sockets.get(accountId)

  sockets.delete(accountId)
  qrCache.delete(accountId)

  if (sock) {
    try {
      if (logout) {
        await sock.logout()
      } else {
        sock.end(undefined)
      }
    } catch (error) {
      logger.warn(
        {
          accountId,
          error: getErrorMessage(error),
        },
        'Error while closing WhatsApp socket',
      )
    }
  }

  if (logout) {
    const account = await db.whatsAppAccount.findUnique({
      where: { id: accountId },
    })

    if (account) {
      await db.whatsAppAccount.update({
        where: { id: accountId },
        data: {
          credsEncrypted: null,
          phoneNumber: null,
          status: 'DISCONNECTED',
          lastError: null,
        },
      })

      await db.whatsAppAuthKey.deleteMany({
        where: { accountId },
      })
    }
  } else {
    await setStatus(accountId, 'DISCONNECTED')
  }
}

// ============================================================
// HTTP API
// ============================================================

const server = createServer(
  async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const url = new URL(
      req.url || '/',
      `http://127.0.0.1:${PORT}`,
    )

    // Health endpoint.
    if (
      req.method === 'GET' &&
      url.pathname === '/health'
    ) {
      return json(res, 200, {
        ok: true,
        service: 'smartserve-baileys-worker',
        activeSessions: sockets.size,
        startingSessions: starting.size,
        queuedMessages: queuedMessageIds.size,
        shuttingDown,
      })
    }

    if (!authorized(req)) {
      return json(res, 401, {
        error: 'Unauthorized',
      })
    }

    try {
      // ------------------------------------------------------
      // START SESSION
      // ------------------------------------------------------

      if (
        req.method === 'POST' &&
        url.pathname === '/sessions'
      ) {
        const body = await readBody(req)

        if (
          typeof body.accountId !== 'string' ||
          !body.accountId.trim()
        ) {
          return json(res, 400, {
            error: 'accountId is required',
          })
        }

        await startSession(body.accountId.trim())

        return json(res, 202, {
          started: true,
          accountId: body.accountId.trim(),
        })
      }

      const match = url.pathname.match(
        /^\/sessions\/([^/]+)(?:\/(qr|send|logout))?$/,
      )

      if (match) {
        const accountId = decodeURIComponent(match[1])
        const action = match[2]

        const accountExists =
          await db.whatsAppAccount.findUnique({
            where: { id: accountId },
            select: { id: true },
          })

        if (!accountExists) {
          return json(res, 404, {
            error: 'WhatsApp account not found',
          })
        }

        // ----------------------------------------------------
        // SESSION STATUS
        // ----------------------------------------------------

        if (
          req.method === 'GET' &&
          !action
        ) {
          const account =
            await db.whatsAppAccount.findUnique({
              where: { id: accountId },
              select: {
                id: true,
                status: true,
                phoneNumber: true,
                lastError: true,
              },
            })

          const qr = qrCache.get(accountId)

          return json(res, 200, {
            account,

            connected:
              sockets.has(accountId) &&
              Boolean(sockets.get(accountId)?.user),

            qr:
              qr && qr.expiresAt > Date.now()
                ? qr.dataUrl
                : null,

            qrExpiresAt: qr?.expiresAt ?? null,
          })
        }

        // ----------------------------------------------------
        // QR CODE
        // ----------------------------------------------------

        if (
          req.method === 'GET' &&
          action === 'qr'
        ) {
          const qr = qrCache.get(accountId)

          return json(res, 200, {
            qr:
              qr && qr.expiresAt > Date.now()
                ? qr.dataUrl
                : null,

            expiresAt: qr?.expiresAt ?? null,
          })
        }

        // ----------------------------------------------------
        // SEND TEXT MESSAGE
        // ----------------------------------------------------

        if (
          req.method === 'POST' &&
          action === 'send'
        ) {
          const body = await readBody(req)

          const sock = sockets.get(accountId)

          if (!sock || !sock.user) {
            return json(res, 409, {
              error: 'WhatsApp account is not connected',
            })
          }

          const digits = normalizePhoneNumber(body.to)
          const text = String(body.text || '').trim()

          if (!digits || !text) {
            return json(res, 400, {
              error:
                'Valid recipient and message text are required',
            })
          }

          if (text.length > MAX_TEXT_LENGTH) {
            return json(res, 400, {
              error:
                `Message cannot exceed ${MAX_TEXT_LENGTH} characters`,
            })
          }

          const result = await sock.sendMessage(
            toJid(digits),
            { text },
          )

          return json(res, 200, {
            ok: true,
            messageId: result?.key?.id || null,
          })
        }

        // ----------------------------------------------------
        // LOGOUT
        // ----------------------------------------------------

        if (
          req.method === 'POST' &&
          action === 'logout'
        ) {
          await stopSession(accountId, true)

          return json(res, 200, {
            disconnected: true,
            loggedOut: true,
          })
        }

        // ----------------------------------------------------
        // DISCONNECT
        // ----------------------------------------------------

        if (
          req.method === 'DELETE' &&
          !action
        ) {
          await stopSession(accountId, false)

          return json(res, 200, {
            disconnected: true,
          })
        }
      }

      return json(res, 404, {
        error: 'Not found',
      })

    } catch (error) {
      logger.error(
        {
          error: getErrorMessage(error),
          path: url.pathname,
        },
        'Worker request failed',
      )

      return json(res, 500, {
        error: getErrorMessage(error),
      })
    }
  },
)

// ============================================================
// RESTORE SAVED WHATSAPP SESSIONS
// ============================================================

server.listen(PORT, '0.0.0.0', async () => {
  logger.info(
    {
      port: PORT,
      appUrl: APP_URL,
    },
    'SmartServe Baileys worker listening',
  )

  try {
    const accounts = await db.whatsAppAccount.findMany({
      where: {
        OR: [
          {
            credsEncrypted: {
              not: null,
            },
          },
          {
            status: {
              in: ['CONNECTING', 'QR_PENDING'],
            },
          },
        ],
      },

      select: {
        id: true,
      },
    })

    logger.info(
      { accountCount: accounts.length },
      'Restoring saved WhatsApp sessions',
    )

    for (const account of accounts) {
      void startSession(account.id).catch((error) => {
        logger.error(
          {
            accountId: account.id,
            error: getErrorMessage(error),
          },
          'Could not restore WhatsApp session',
        )
      })
    }
  } catch (error) {
    logger.error(
      {
        error: getErrorMessage(error),
      },
      'Could not restore WhatsApp sessions',
    )
  }
})

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(): Promise<void> {
  if (shuttingDown) return

  shuttingDown = true

  logger.info(
    'Shutting down SmartServe Baileys worker',
  )

  for (const accountId of [...reconnectTimers.keys()]) {
    clearReconnectTimer(accountId)
  }

  for (const accountId of [...sockets.keys()]) {
    await stopSession(
      accountId,
      false,
    ).catch((error) => {
      logger.error(
        {
          accountId,
          error: getErrorMessage(error),
        },
        'Could not stop WhatsApp session',
      )
    })
  }

  // Allow already queued messages to finish.
  await Promise.allSettled(
    [...incomingQueues.values()],
  )

  server.close(() => {
    process.exit(0)
  })

  setTimeout(() => {
    process.exit(1)
  }, 10000).unref()
}

process.on('SIGTERM', () => {
  void shutdown()
})

process.on('SIGINT', () => {
  void shutdown()
})
