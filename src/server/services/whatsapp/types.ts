import { createLogger } from '@/server/logger'
import { verifyMetaSignature } from '@/server/crypto'

const log = createLogger('whatsapp')

/**
 * WhatsAppProvider abstraction (spec §12/§13/§63).
 * The Meta-specific implementation is isolated in meta-provider.ts; the
 * development adapter (dev-provider.ts) is used ONLY when no real
 * credentials exist and never claims to be production-connected.
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
  sendMediaMessage(to: string, type: 'image' | 'document', link: string, caption?: string): Promise<SendResult>
  markMessageRead(whatsappMessageId: string): Promise<void>
  verifyConnection(): Promise<{ ok: boolean; error?: string }>
}

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, appSecret?: string | null): boolean {
  return verifyMetaSignature(rawBody, signatureHeader, appSecret)
}

/** Zod-style structural validation of Meta webhook payloads (spec §50). */
export function extractInboundMessages(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = []
  try {
    const root = payload as {
      entry?: Array<{
        id?: string
        changes?: Array<{
          field?: string
          value?: {
            metadata?: { phone_number_id?: string }
            contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>
            messages?: Array<Record<string, unknown>>
          }
        }>
      }>
    }
    for (const entry of root.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        if (!value?.messages || !value.metadata?.phone_number_id) continue
        const contactName = value.contacts?.[0]?.profile?.name
        for (const message of value.messages) {
          const id = message.id as string | undefined
          const from = message.from as string | undefined
          if (!id || !from) continue
          const msgType = (message.type as string) || 'text'
          let text: string | undefined
          let mediaId: string | undefined
          let mediaMimeType: string | undefined
          let mediaUrl: string | undefined
          if (msgType === 'text') {
            text = (message.text as { body?: string })?.body
          } else {
            const media = (message as Record<string, { id?: string; mime_type?: string }>)[msgType]
            mediaId = media?.id
            mediaMimeType = media?.mime_type
          }
          const ts = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date()
          out.push({
            phoneNumberId: value.metadata.phone_number_id,
            from,
            profileName: contactName,
            whatsappMessageId: id,
            timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
            type: msgType.toUpperCase(),
            text,
            mediaId,
            mediaMimeType,
            mediaUrl,
            raw: message,
          })
        }
      }
    }
  } catch (error) {
    log.error('webhook.extract_failed', { message: error instanceof Error ? error.message : String(error) })
  }
  return out
}

/** Delivery/read receipt extraction from status webhooks. */
export function extractStatusUpdates(payload: unknown): Array<{ whatsappMessageId: string; status: string; recipientId?: string }> {
  const out: Array<{ whatsappMessageId: string; status: string; recipientId?: string }> = []
  try {
    const root = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: { statuses?: Array<{ id?: string; status?: string; recipient_id?: string }> }
        }>
      }>
    }
    for (const entry of root.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const status of change.value?.statuses ?? []) {
          if (status.id && status.status) {
            out.push({ whatsappMessageId: status.id, status: status.status.toUpperCase(), recipientId: status.recipient_id })
          }
        }
      }
    }
  } catch {
    // malformed status payload — ignore
  }
  return out
}
