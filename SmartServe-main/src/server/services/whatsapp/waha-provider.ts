
import { createLogger } from '@/server/logger'
import type { SendResult, WhatsAppProvider } from './types'

const log = createLogger('whatsapp-waha')

export class WahaWhatsAppProvider implements WhatsAppProvider {
  readonly kind = 'waha' as const

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly session: string

  constructor() {
    this.baseUrl = (process.env.WAHA_BASE_URL || '').replace(/\/+$/, '')
    this.apiKey = process.env.WAHA_API_KEY || ''
    this.session = process.env.WAHA_SESSION || 'default'

    if (!this.baseUrl || !this.apiKey) {
      throw new Error('WAHA_BASE_URL and WAHA_API_KEY must be configured')
    }
  }

  private async request(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(`WAHA request failed with HTTP ${response.status}`)
    }

    return response.json()
  }

  async verifyConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request(`/api/sessions/${encodeURIComponent(this.session)}`)
      return { ok: true }
    } catch {
      return { ok: false, error: 'Could not verify the WAHA session' }
    }
  }

  async sendTextMessage(to: string, body: string): Promise<SendResult> {
    try {
      const result = await this.request('/api/sendText', {
        session: this.session,
        chatId: to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`,
        text: body,
      })

      return { ok: true, messageId: result?.id?._serialized ?? result?.id }
    } catch (error) {
      log.error('send_text_failed', {
        message: error instanceof Error ? error.message : 'Unknown error',
      })
      return { ok: false, error: 'WAHA could not send the message' }
    }
  }

  async sendMediaMessage(
    to: string,
    type: 'image' | 'document',
    link: string,
    caption?: string,
  ): Promise<SendResult> {
    try {
      const result = await this.request('/api/sendImage', {
        session: this.session,
        chatId: to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`,
        file: { url: link },
        caption: caption ?? '',
      })

      return { ok: true, messageId: result?.id?._serialized ?? result?.id }
    } catch (error) {
      log.error('send_media_failed', {
        message: error instanceof Error ? error.message : 'Unknown error',
        type,
      })
      return { ok: false, error: 'WAHA could not send the media' }
    }
  }

  async markMessageRead(_whatsappMessageId: string): Promise<void> {
    // Read receipts are not implemented in this initial adapter.
  }
}
