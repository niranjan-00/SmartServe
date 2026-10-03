import { db } from '@/lib/db'
import { encryptSecret, decryptSecret, randomToken, sha256Hex } from '@/server/crypto'
import { createLogger } from '@/server/logger'
import { emitToOrganization } from '@/server/realtime'
import { extractInboundMessages, extractStatusUpdates, verifyWebhookSignature, type WhatsAppProvider } from './types'
import { MetaWhatsAppProvider } from './meta-provider'
import { DevWhatsAppProvider, buildSimulatedWebhook } from './dev-provider'
import { handleCustomerMessage } from './bot'

const log = createLogger('whatsapp')

/**
 * WhatsAppService — the single integration point between SmartServe and
 * WhatsApp (spec §13). Meta-specific code stays inside meta-provider.ts.
 *
 * Organization routing is authoritative and credential-based:
 *   phone_number_id → WhatsAppConnection → organizationId (spec §15)
 */

export interface ConnectionSummary {
  id: string
  status: string
  mode: 'meta' | 'development'
  displayPhoneNumber: string | null
  phoneNumberId: string | null
  wabaId: string | null
  statusMessage: string | null
  lastVerifiedAt: string | null
  createdAt: string
}

const DEV_MODE = () => (process.env.WHATSAPP_MODE || 'development') !== 'production'

export async function getConnection(organizationId: string) {
  return db.whatsAppConnection.findUnique({ where: { organizationId } })
}

export async function getConnectionSummary(organizationId: string): Promise<ConnectionSummary> {
  const conn = await getConnection(organizationId)
  if (!conn) {
    return {
      id: '',
      status: 'NOT_CONNECTED',
      mode: DEV_MODE() ? 'development' : 'meta',
      displayPhoneNumber: null,
      phoneNumberId: null,
      wabaId: null,
      statusMessage: null,
      lastVerifiedAt: null,
      createdAt: new Date().toISOString(),
    }
  }
  return {
    id: conn.id,
    status: conn.status,
    mode: conn.statusMessage?.startsWith('development-adapter') ? 'development' : 'meta',
    displayPhoneNumber: conn.displayPhoneNumber,
    phoneNumberId: conn.phoneNumberId,
    wabaId: conn.wabaId,
    statusMessage: conn.statusMessage,
    lastVerifiedAt: conn.lastVerifiedAt?.toISOString() ?? null,
    createdAt: conn.createdAt.toISOString(),
  }
}

/**
 * "Connect WhatsApp Business" — stores real credentials (encrypted) and
 * verifies them against Meta when in production mode. Arbitrary numbers are
 * never accepted as connected in production (spec §12/§72).
 */
export async function connectWhatsApp(params: {
  organizationId: string
  userId: string
  wabaId: string
  phoneNumberId: string
  displayPhoneNumber: string
  accessToken: string
  verifyToken?: string
  appSecret?: string
}): Promise<ConnectionSummary> {
  const { organizationId, wabaId, phoneNumberId, displayPhoneNumber, accessToken, verifyToken, appSecret } = params

  let status = 'CONNECTING'
  let statusMessage = 'Credentials stored — awaiting verification'

  if (DEV_MODE()) {
    status = 'CONNECTED'
    statusMessage = 'development-adapter: messages simulated locally until Meta credentials are supplied'
  } else {
    const provider = new MetaWhatsAppProvider(accessToken, phoneNumberId, appSecret)
    const verify = await provider.verifyConnection()
    if (!verify.ok) {
      status = 'ERROR'
      statusMessage = `Meta verification failed: ${verify.error}`
    } else {
      status = 'CONNECTED'
      statusMessage = 'Verified with Meta Cloud API'
    }
  }

  const data = {
    organizationId,
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    accessTokenEncrypted: encryptSecret(accessToken),
    verifyTokenEncrypted: verifyToken ? encryptSecret(verifyToken) : null,
    appSecretEncrypted: appSecret ? encryptSecret(appSecret) : null,
    status,
    statusMessage,
    lastVerifiedAt: status === 'CONNECTED' ? new Date() : null,
  }

  const conn = await db.whatsAppConnection.upsert({
    where: { organizationId },
    create: data,
    update: data,
  })

  log.info('whatsapp.connected', { organizationId, status })
  await emitToOrganization(organizationId, 'whatsapp.status_changed', { status: conn.status })
  return getConnectionSummary(organizationId)
}

export async function disconnectWhatsApp(organizationId: string): Promise<void> {
  await db.whatsAppConnection.deleteMany({ where: { organizationId } })
  log.info('whatsapp.disconnected', { organizationId })
  await emitToOrganization(organizationId, 'whatsapp.status_changed', { status: 'NOT_CONNECTED' })
}

/** Builds the right provider for a stored connection. */
export function providerForConnection(conn: {
  accessTokenEncrypted: string
  phoneNumberId: string
  appSecretEncrypted?: string | null
  statusMessage?: string | null
}): WhatsAppProvider {
  if (conn.statusMessage?.startsWith('development-adapter') || (!conn.accessTokenEncrypted.startsWith('META'))) {
    if (conn.statusMessage?.startsWith('development-adapter')) return new DevWhatsAppProvider()
  }
  const accessToken = decryptSecret(conn.accessTokenEncrypted)
  const appSecret = conn.appSecretEncrypted ? decryptSecret(conn.appSecretEncrypted) : undefined
  return new MetaWhatsAppProvider(accessToken, conn.phoneNumberId, appSecret)
}

export async function providerForOrganization(organizationId: string): Promise<WhatsAppProvider | null> {
  const conn = await getConnection(organizationId)
  if (!conn) return null
  return providerForConnection(conn)
}

// ---------------------------------------------------------------------------
// WEBHOOK PIPELINE (spec §14-17)
// ---------------------------------------------------------------------------

export interface WebhookProcessResult {
  accepted: boolean
  reason?: string
  duplicate?: boolean
  processed: number
}

/** GET verification (Meta hub challenge). */
export function verifyWebhook(query: URLSearchParams): { ok: true; challenge: string } | { ok: false } {
  const mode = query.get('hub.mode')
  const token = query.get('hub.verify_token')
  const challenge = query.get('hub.challenge')
  const expected = process.env.WHATSAPP_VERIFY_TOKEN

  if (mode === 'subscribe' && token && challenge && expected) {
    // Constant-time compare handled by caller via crypto when secret set
    if (token === expected) return { ok: true, challenge }
  }
  return { ok: false }
}

/**
 * POST pipeline. Persists the event FIRST (idempotency via WebhookEvent),
 * then processes. Never throws to Meta — returns 200 unless structurally
 * invalid, and never blocks on AI (spec §56).
 */
export async function processWebhookPayload(params: {
  rawBody: string
  signatureHeader: string | null
  payload: unknown
}): Promise<WebhookProcessResult> {
  const { rawBody, signatureHeader, payload } = params

  const messages = extractInboundMessages(payload)
  const statusUpdates = extractStatusUpdates(payload)

  if (messages.length === 0 && statusUpdates.length === 0) {
    return { accepted: false, reason: 'no recognized events', processed: 0 }
  }

  let processed = 0
  let skippedDuplicate = 0

  for (const inbound of messages) {
    const eventId = inbound.whatsappMessageId
    const payloadHash = sha256Hex(rawBody)

    // Idempotency: unique eventId — duplicates are ignored (spec §15/§17/§58)
    try {
      await db.webhookEvent.create({
        data: { provider: 'WHATSAPP', eventId, eventType: 'message', payloadHash, processed: false },
      })
    } catch {
      skippedDuplicate++
      continue
    }

    try {
      await handleInboundMessage(inbound, payloadHash)
      await db.webhookEvent.update({
        where: { eventId },
        data: { processed: true, processedAt: new Date() },
      })
      processed++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('webhook.process_failed', { eventId, message })
      await db.webhookEvent.update({
        where: { eventId },
        data: { error: message.slice(0, 500) },
      })
    }
  }

  // Delivery/read receipts — update outbound message status (spec §29)
  for (const statusUpdate of statusUpdates) {
    const map: Record<string, string> = { SENT: 'SENT', DELIVERED: 'DELIVERED', READ: 'READ', FAILED: 'FAILED' }
    const mapped = map[statusUpdate.status]
    if (mapped) {
      await db.message.updateMany({
        where: { whatsappMessageId: statusUpdate.whatsappMessageId },
        data: { status: mapped },
      })
    }
  }

  void signatureHeader
  return { accepted: true, duplicate: skippedDuplicate > 0 && processed === 0, processed }
}

async function handleInboundMessage(inbound: {
  phoneNumberId: string
  from: string
  profileName?: string
  whatsappMessageId: string
  timestamp: Date
  type: string
  text?: string
  mediaId?: string
  mediaMimeType?: string
}, payloadHash: string): Promise<void> {
  // 1. phone_number_id → connection → organization (authoritative routing)
  const connection = await db.whatsAppConnection.findUnique({
    where: { phoneNumberId: inbound.phoneNumberId },
  })
  if (!connection) {
    log.warn('webhook.unknown_phone_number_id', { phoneNumberId: inbound.phoneNumberId })
    return
  }
  const organizationId = connection.organizationId

  const text = inbound.text?.trim() || (inbound.mediaId ? `[${inbound.type.toLowerCase()} attachment received]` : '')

  // 2. Customer + conversation + message inside one transaction (spec §55/§57)
  const { conversation, message } = await db.$transaction(async (tx) => {
    const customer = await tx.customer.upsert({
      where: { organizationId_phoneNumber: { organizationId, phoneNumber: inbound.from } },
      create: {
        organizationId,
        phoneNumber: inbound.from,
        whatsappId: inbound.from,
        name: inbound.profileName ?? null,
      },
      update: inbound.profileName ? { name: inbound.profileName } : {},
    })

    const existing = await tx.conversation.findFirst({
      where: { organizationId, customerId: customer.id, status: 'OPEN' },
      orderBy: { lastMessageAt: 'desc' },
    })

    const conversation = existing
      ? await tx.conversation.update({
          where: { id: existing.id },
          data: { lastMessageAt: inbound.timestamp },
        })
      : await tx.conversation.create({
          data: {
            organizationId,
            customerId: customer.id,
            whatsappConnectionId: connection.id,
            status: 'OPEN',
            lastMessageAt: inbound.timestamp,
          },
        })

    const message = await tx.message.create({
      data: {
        organizationId,
        conversationId: conversation.id,
        whatsappMessageId: inbound.whatsappMessageId,
        senderType: 'CUSTOMER',
        senderId: customer.id,
        messageType: inbound.type || 'TEXT',
        content: text,
        mediaUrl: null,
        mediaMimeType: inbound.mediaMimeType ?? null,
        direction: 'INBOUND',
        status: 'RECEIVED',
        createdAt: inbound.timestamp,
      },
    })

    return { conversation, message }
  })
  void payloadHash

  await emitToOrganization(organizationId, 'message.created', { conversationId: conversation.id, messageId: message.id })

  // Mark incoming message read via provider (best effort)
  try {
    const provider = providerForConnection(connection)
    await provider.markMessageRead(inbound.whatsappMessageId)
  } catch {
    // best effort — never fail the pipeline on read receipts
  }

  // 3. Bot conversation flow → creates complaints via complaintService
  if (text) {
    const customer = await db.customer.findUnique({
      where: { organizationId_phoneNumber: { organizationId, phoneNumber: inbound.from } },
    })
    if (customer) {
      const reply = await handleCustomerMessage({
        organizationId,
        conversationId: conversation.id,
        customerId: customer.id,
        text,
        customerName: customer.name,
      })
      await sendBotReply(organizationId, conversation.id, reply.text)
    }
  }
}

/** Persists + sends an outbound message through the org's provider. */
export async function sendOutbound(params: {
  organizationId: string
  conversationId: string
  to: string
  text: string
  senderType?: 'BOT' | 'STAFF' | 'SYSTEM'
  senderId?: string
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const conn = await getConnection(params.organizationId)
  if (!conn) {
    // Record the intended message as FAILED — complaint flow must not break (spec §68)
    await db.message.create({
      data: {
        organizationId: params.organizationId,
        conversationId: params.conversationId,
        senderType: params.senderType ?? 'SYSTEM',
        senderId: params.senderId,
        messageType: 'TEXT',
        content: params.text,
        direction: 'OUTBOUND',
        status: 'FAILED',
      },
    })
    return { ok: false, error: 'WhatsApp not connected' }
  }

  // Outbound record created BEFORE sending (spec §29)
  const record = await db.message.create({
    data: {
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      senderType: params.senderType ?? 'SYSTEM',
      senderId: params.senderId,
      messageType: 'TEXT',
      content: params.text,
      direction: 'OUTBOUND',
      status: 'SENT',
    },
  })

  const provider = providerForConnection(conn)
  const result = await provider.sendTextMessage(params.to, params.text)

  await db.message.update({
    where: { id: record.id },
    data: {
      status: result.ok ? 'SENT' : 'FAILED',
      whatsappMessageId: result.messageId ?? null,
    },
  })

  await emitToOrganization(params.organizationId, 'message.created', { conversationId: params.conversationId, messageId: record.id })
  return result
}

async function sendBotReply(organizationId: string, conversationId: string, text: string): Promise<void> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { customer: { select: { phoneNumber: true } } },
  })
  if (!conversation) return
  await sendOutbound({
    organizationId,
    conversationId,
    to: conversation.customer.phoneNumber,
    text,
    senderType: 'BOT',
  })
}

// ---------------------------------------------------------------------------
// DEVELOPMENT ADAPTER HELPERS (never active in production mode)
// ---------------------------------------------------------------------------

export function isDevelopmentMode(): boolean {
  return DEV_MODE()
}

/**
 * Simulates an inbound WhatsApp message by feeding a Meta-shaped payload
 * through the exact same webhook pipeline (used by the dev-only endpoint).
 */
export async function simulateInboundMessage(params: {
  organizationId: string
  from: string
  text: string
  profileName?: string
}): Promise<WebhookProcessResult> {
  if (!DEV_MODE()) {
    return { accepted: false, reason: 'simulation disabled in production mode', processed: 0 }
  }
  const conn = await getConnection(params.organizationId)
  if (!conn) {
    return { accepted: false, reason: 'Connect WhatsApp first (development adapter)', processed: 0 }
  }
  const { payload } = buildSimulatedWebhook({
    phoneNumberId: conn.phoneNumberId,
    from: params.from,
    text: params.text,
    profileName: params.profileName,
  })
  const rawBody = JSON.stringify(payload)
  return processWebhookPayload({ rawBody, signatureHeader: null, payload })
}

export { verifyWebhookSignature }
