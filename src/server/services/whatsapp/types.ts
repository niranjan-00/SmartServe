
import { createLogger } from '@/server/logger'
import { verifyMetaSignature } from '@/server/crypto'

const log = createLogger('whatsapp')

/**
 * WhatsAppProvider abstraction.
 *
 * Meta-specific implementation is isolated in meta-provider.ts.
 * The development adapter must never claim to be production-connected.
 */

export interface SendResult {
  ok: boolean
  messageId?: string
  error?: string
}

export interface InboundMessage {
  phoneNumberId: string
  from: string
  profileName?: string
  whatsappMessageId: string
  timestamp: Date
  type: string
  text?: string
  mediaId?: string
  mediaMimeType?: string
  mediaUrl?: string
  raw: unknown
}

export interface WhatsAppProvider {
  readonly kind: 'meta' | 'development' | 'waha'

  sendTextMessage(to: string, body: string): Promise<SendResult>

  sendMediaMessage(
    to: string,
    type: 'image' | 'document',
    link: string,
    caption?: string,
  ): Promise<SendResult>

  markMessageRead(whatsappMessageId: string): Promise<void>

  verifyConnection(): Promise<{ ok: boolean; error?: string }>
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getRecord(
  value: unknown,
  key: string,
): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined

  const nested = value[key]
  return isRecord(nested) ? nested : undefined
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function getContactName(
  contacts: unknown[],
  senderId: string,
): string | undefined {
  for (const contact of contacts) {
    if (!isRecord(contact)) continue

    if (asString(contact.wa_id) !== senderId) continue

    const profile = getRecord(contact, 'profile')
    return asString(profile?.name)
  }

  return undefined
}

function getMessageText(
  message: UnknownRecord,
  messageType: string,
): string | undefined {
  if (messageType === 'text') {
    return asString(getRecord(message, 'text')?.body)
  }

  if (messageType === 'button') {
    return (
      asString(getRecord(message, 'button')?.text) ??
      asString(getRecord(message, 'button')?.payload)
    )
  }

  if (messageType === 'interactive') {
    const interactive = getRecord(message, 'interactive')

    const buttonReply = getRecord(interactive, 'button_reply')
    const listReply = getRecord(interactive, 'list_reply')

    return (
      asString(buttonReply?.title) ??
      asString(buttonReply?.id) ??
      asString(listReply?.title) ??
      asString(listReply?.id)
    )
  }

  if (
    messageType === 'image' ||
    messageType === 'video' ||
    messageType === 'document'
  ) {
    return asString(getRecord(message, messageType)?.caption)
  }

  if (messageType === 'location') {
    const location = getRecord(message, 'location')

    const name = asString(location?.name)
    const address = asString(location?.address)

    return [name, address].filter(Boolean).join(', ') || undefined
  }

  if (messageType === 'contacts') {
    return 'Contact shared'
  }

  if (messageType === 'sticker') {
    return 'Sticker received'
  }

  return undefined
}

function getMediaDetails(
  message: UnknownRecord,
  messageType: string,
): {
  mediaId?: string
  mediaMimeType?: string
  mediaUrl?: string
} {
  const supportedMediaTypes = new Set([
    'image',
    'video',
    'audio',
    'document',
    'sticker',
  ])

  if (!supportedMediaTypes.has(messageType)) {
    return {}
  }

  const media = getRecord(message, messageType)

  if (!media) return {}

  return {
    mediaId: asString(media.id),
    mediaMimeType: asString(media.mime_type),
    // Meta webhook payloads normally provide a media ID, not a public URL.
    // The actual URL must be obtained through the authenticated media API.
    mediaUrl: undefined,
  }
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined
  }

  const seconds = Number(value)

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined
  }

  const date = new Date(seconds * 1000)

  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  return date
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret?: string | null,
): boolean {
  return verifyMetaSignature(rawBody, signatureHeader, appSecret)
}

/**
 * Extract inbound messages from Meta WhatsApp webhook payloads.
 *
 * Invalid individual messages are skipped without preventing other
 * valid messages in the same webhook from being processed.
 */
export function extractInboundMessages(
  payload: unknown,
): InboundMessage[] {
  const output: InboundMessage[] = []

  if (!isRecord(payload)) {
    log.warn('webhook.invalid_payload', {
      reason: 'Payload must be an object',
    })

    return output
  }

  const entries = getArray(payload.entry)

  for (const entry of entries) {
    if (!isRecord(entry)) continue

    const changes = getArray(entry.changes)

    for (const change of changes) {
      if (!isRecord(change)) continue

      if (change.field !== 'messages') continue

      const value = getRecord(change, 'value')

      if (!value) continue

      const metadata = getRecord(value, 'metadata')
      const phoneNumberId = asString(metadata?.phone_number_id)

      if (!phoneNumberId) {
        log.warn('webhook.missing_phone_number_id')
        continue
      }

      const contacts = getArray(value.contacts)
      const messages = getArray(value.messages)

      for (const item of messages) {
        try {
          if (!isRecord(item)) continue

          const id = asString(item.id)
          const from = asString(item.from)

          if (!id || !from) {
            log.warn('webhook.invalid_message', {
              reason: 'Missing message ID or sender',
            })

            continue
          }

          // Avoid accepting unexpectedly large identifiers.
          if (id.length > 512 || from.length > 64) {
            log.warn('webhook.invalid_message', {
              reason: 'Message ID or sender exceeds allowed length',
            })

            continue
          }

          const messageType = (
            asString(item.type) ?? 'text'
          ).toLowerCase()

          if (messageType.length > 64) continue

          const timestamp = parseTimestamp(item.timestamp)

          if (!timestamp) {
            log.warn('webhook.invalid_timestamp', {
              whatsappMessageId: id,
            })

            continue
          }

          const media = getMediaDetails(item, messageType)

          output.push({
            phoneNumberId,
            from,
            profileName: getContactName(contacts, from),
            whatsappMessageId: id,
            timestamp,
            type: messageType.toUpperCase(),
            text: getMessageText(item, messageType),
            mediaId: media.mediaId,
            mediaMimeType: media.mediaMimeType,
            mediaUrl: media.mediaUrl,
            raw: item,
          })
        } catch (error) {
          log.error('webhook.message_extraction_failed', {
            message:
              error instanceof Error
                ? error.message
                : String(error),
          })
        }
      }
    }
  }

  return output
}

/**
 * Extract delivery and read receipts from Meta status webhooks.
 */
export function extractStatusUpdates(
  payload: unknown,
): Array<{
  whatsappMessageId: string
  status: string
  recipientId?: string
}> {
  const output: Array<{
    whatsappMessageId: string
    status: string
    recipientId?: string
  }> = []

  if (!isRecord(payload)) return output

  const entries = getArray(payload.entry)

  for (const entry of entries) {
    if (!isRecord(entry)) continue

    const changes = getArray(entry.changes)

    for (const change of changes) {
      if (!isRecord(change)) continue

      if (change.field !== 'messages') continue

      const value = getRecord(change, 'value')
      if (!value) continue

      const statuses = getArray(value.statuses)

      for (const item of statuses) {
        if (!isRecord(item)) continue

        const id = asString(item.id)
        const status = asString(item.status)
        const recipientId = asString(item.recipient_id)

        if (!id || !status) continue

        if (id.length > 512 || status.length > 64) continue

        output.push({
          whatsappMessageId: id,
          status: status.toUpperCase(),
          recipientId,
        })
      }
    }
  }

  return output
}
