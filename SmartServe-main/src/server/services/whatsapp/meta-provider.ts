import type { SendResult, WhatsAppProvider } from './types'
import { createLogger } from '@/server/logger'

const log = createLogger('whatsapp.meta')

/**
 * Meta WhatsApp Business Cloud API provider (spec §12/§13/§15/§31).
 * All Graph API access lives here — no other module talks to Meta directly.
 */

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly kind = 'meta' as const

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly appSecret?: string,
  ) {}

  private async graphCall(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${GRAPH_BASE}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(15_000),
    })
  }

  async sendTextMessage(to: string, body: string): Promise<SendResult> {
    try {
      const res = await this.graphCall(`${this.phoneNumberId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body },
        }),
      })
      const json = (await res.json()) as { messages?: Array<{ id: string }>; error?: { message: string } }
      if (!res.ok) {
        log.error('send.failed', { status: res.status, error: json.error?.message })
        return { ok: false, error: json.error?.message || `Meta API error ${res.status}` }
      }
      return { ok: true, messageId: json.messages?.[0]?.id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'network error' }
    }
  }

  async sendMediaMessage(to: string, type: 'image' | 'document', link: string, caption?: string): Promise<SendResult> {
    try {
      const body: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to,
        type,
        [type]: { link, ...(caption ? { caption } : {}) },
      }
      const res = await this.graphCall(`${this.phoneNumberId}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { messages?: Array<{ id: string }>; error?: { message: string } }
      if (!res.ok) return { ok: false, error: json.error?.message || `Meta API error ${res.status}` }
      return { ok: true, messageId: json.messages?.[0]?.id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'network error' }
    }
  }

  async markMessageRead(whatsappMessageId: string): Promise<void> {
    try {
      await this.graphCall(`${this.phoneNumberId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: whatsappMessageId,
        }),
      })
    } catch (error) {
      log.warn('markRead.failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Verifies the access token + phone number actually exist via Graph API. */
  async verifyConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.graphCall(`${this.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { method: 'GET' })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        return { ok: false, error: json.error?.message || `Meta API error ${res.status}` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'network error' }
    }
  }
}
