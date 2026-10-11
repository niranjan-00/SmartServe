import crypto from 'crypto'
import type { InboundMessage, SendResult, WhatsAppProvider } from './types'
import { createLogger } from '@/server/logger'

const log = createLogger('whatsapp.dev')

/**
 * DEVELOPMENT ADAPTER (spec §12: "Create a clean provider abstraction and
 * development adapter. Never pretend a mock WhatsApp connection is
 * production-connected.")
 *
 * - Active ONLY when WHATSAPP_MODE=development (or unset) — the production
 *   mode requires real Meta credentials and verifies them via Graph API.
 * - UI surfaces a visible "Development adapter" badge; status is DEVELOPMENT,
 *   never presented as CONNECTED to Meta.
 * - Allows simulating inbound customer messages so the full webhook →
 *   complaint → AI → assignment pipeline can be exercised end-to-end without
 *   a Meta business account.
 */

export class DevWhatsAppProvider implements WhatsAppProvider {
  readonly kind = 'development' as const

  async sendTextMessage(to: string, body: string): Promise<SendResult> {
    log.info('dev.sendText', { to, length: body.length })
    return { ok: true, messageId: `dev.${crypto.randomUUID()}` }
  }

  async sendMediaMessage(to: string, type: 'image' | 'document', link: string): Promise<SendResult> {
    log.info('dev.sendMedia', { to, type, link })
    return { ok: true, messageId: `dev.${crypto.randomUUID()}` }
  }

  async markMessageRead(): Promise<void> {
    /* no-op in development adapter */
  }

  async verifyConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true }
  }
}

/** Builds a Meta-shaped inbound webhook payload for local simulation. */
export function buildSimulatedWebhook(opts: {
  phoneNumberId: string
  from: string
  text: string
  profileName?: string
}): { payload: unknown; inbound: InboundMessage } {
  const id = `wamid.SIM${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'SIMULATED_WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: opts.phoneNumberId },
              contacts: [{ profile: { name: opts.profileName || 'Simulated Customer' }, wa_id: opts.from }],
              messages: [
                {
                  from: opts.from,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  text: { body: opts.text },
                  type: 'text',
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const [inbound] = (function extract(): InboundMessage[] {
    // reuse structural extraction by importing lazily to avoid cycles
    return []
  })()
  void inbound
  return {
    payload,
    inbound: {
      phoneNumberId: opts.phoneNumberId,
      from: opts.from,
      profileName: opts.profileName || 'Simulated Customer',
      whatsappMessageId: id,
      timestamp: new Date(),
      type: 'TEXT',
      text: opts.text,
      raw: payload,
    },
  }
}
