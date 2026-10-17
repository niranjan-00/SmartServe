
import { createLogger } from '@/server/logger'
import type { SendResult, WhatsAppProvider } from './types'

const log = createLogger('whatsapp-waha')

type WahaSession = {
  name?: string
  status?: string
  engine?: { engine?: string }
}

type WahaMessageResult = {
  id?: string | { _serialized?: string }
  message?: string
}

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
      throw new Error(
        'WAHA_BASE_URL and WAHA_API_KEY must be configured',
      )
    }
  }

  private async request<T>(
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
      },
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })

    const responseText = await response.text()

    let data: unknown = null

    if (responseText) {
      try {
        data = JSON.parse(responseText)
      } catch {
        data = responseText
      }
    }

    if (!response.ok) {
      const details =
        typeof data === 'object' &&
        data !== null &&
        'message' in data &&
        typeof data.message === 'string'
          ? data.message
          : typeof data === 'string'
            ? data.slice(0, 200)
            : `HTTP ${response.status}`

      throw new Error(
        `WAHA ${path} failed (${response.status}): ${details}`,
      )
    }

    return data as T
  }

  /**
   * Verifies API access and checks whether the configured
   * WhatsApp session is authenticated and ready to use.
   */
  async verifyConnection(): Promise<{
    ok: boolean
    error?: string
  }> {
    try {
      const session = await this.request<WahaSession>(
        `/api/sessions/${encodeURIComponent(this.session)}`,
      )

      const status = session.status?.toUpperCase()

      if (!status) {
        return {
          ok: false,
          error:
            'WAHA returned no session status. Check the session in the WAHA dashboard.',
        }
      }

      if (status !== 'WORKING') {
        return {
          ok: false,
          error: `WAHA session "${this.session}" is ${status}. Start the session and complete WhatsApp authentication if required.`,
        }
      }

      return { ok: true }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown error'

      log.error('verify_connection_failed', { message })

      return {
        ok: false,
        error: message,
      }
    }
  }

  private normalizeChatId(to: string): string {
    const recipient = to.trim()

    if (recipient.endsWith('@c.us') ||
        recipient.endsWith('@g.us') ||
        recipient.endsWith('@lid')) {
      return recipient
    }

    const digits = recipient.replace(/\D/g, '')

    if (!digits) {
      throw new Error('A valid WhatsApp recipient is required')
    }

    return `${digits}@c.us`
  }

  private extractMessageId(
    result: WahaMessageResult,
  ): string | undefined {
    if (typeof result.id === 'string') {
      return result.id
    }

    return result.id?._serialized
  }

  async sendTextMessage(
    to: string,
    body: string,
  ): Promise<SendResult> {
    try {
      if (!body.trim()) {
        return { ok: false, error: 'Message text cannot be empty' }
      }

      const result = await this.request<WahaMessageResult>(
        '/api/sendText',
        {
          session: this.session,
          chatId: this.normalizeChatId(to),
          text: body,
        },
      )

      return {
        ok: true,
        messageId: this.extractMessageId(result),
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error'

      log.error('send_text_failed', { message })

      return {
        ok: false,
        error: message,
      }
    }
  }

  async sendMediaMessage(
    to: string,
    type: 'image' | 'document',
    link: string,
    caption?: string,
  ): Promise<SendResult> {
    try {
      const url = new URL(link)

      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return {
          ok: false,
          error: 'Media URL must use HTTP or HTTPS',
        }
      }

      const endpoint =
        type === 'image' ? '/api/sendImage' : '/api/sendFile'

      const result = await this.request<WahaMessageResult>(
        endpoint,
        {
          session: this.session,
          chatId: this.normalizeChatId(to),
          file: { url: url.toString() },
          ...(caption ? { caption } : {}),
        },
      )

      return {
        ok: true,
        messageId: this.extractMessageId(result),
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error'

      log.error('send_media_failed', { message, type })

      return {
        ok: false,
        error: message,
      }
    }
  }

  async markMessageRead(
    _whatsappMessageId: string,
  ): Promise<void> {
    // Read receipts require the appropriate chat and message IDs.
    // This provider interface supplies only the message ID.
  }
}
