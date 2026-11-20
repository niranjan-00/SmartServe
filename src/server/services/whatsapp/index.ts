
import { db } from '@/lib/db'
import { getStorage } from '@/server/services/storage'
import crypto from 'crypto'
import path from 'path'

import {
  encryptSecret,
  decryptSecret,
  sha256Hex,
} from '@/server/crypto'

import { createLogger } from '@/server/logger'
import { emitToOrganization } from '@/server/realtime'

import {
  extractInboundMessages,
  extractStatusUpdates,
  verifyWebhookSignature,
  type WhatsAppProvider,
} from './types'

import { MetaWhatsAppProvider } from './meta-provider'
import {
  DevWhatsAppProvider,
  buildSimulatedWebhook,
} from './dev-provider'
import { WahaWhatsAppProvider } from './waha-provider'
import { handleCustomerMessage } from './bot'
import { callBaileysWorker } from './baileys-client'

const log = createLogger('whatsapp')

export interface ConnectionSummary {
  id: string
  status: string
  mode: 'meta' | 'development' | 'waha'
  displayPhoneNumber: string | null
  phoneNumberId: string | null
  wabaId: string | null
  statusMessage: string | null
  lastVerifiedAt: string | null
  createdAt: string
}

const DEV_MODE = () =>
  (process.env.WHATSAPP_MODE || 'development') !== 'production'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeDate(value: string | Date | undefined | null): Date {
  if (!value) return new Date()

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? new Date() : date
}

function normalizePhoneNumber(value: string): string {
  return value.replace(/[^\d]/g, '')
}

function isPrismaUniqueError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

// -----------------------------------------------------------------------------
// CONNECTION MANAGEMENT
// -----------------------------------------------------------------------------

export async function getConnection(organizationId: string) {
  return db.whatsAppConnection.findUnique({
    where: { organizationId },
  })
}

export async function getConnectionSummary(
  organizationId: string,
): Promise<ConnectionSummary> {
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

  const mode: ConnectionSummary['mode'] =
    conn.statusMessage?.startsWith('development-adapter')
      ? 'development'
      : conn.statusMessage?.startsWith('waha-adapter')
        ? 'waha'
        : 'meta'

  return {
    id: conn.id,
    status: conn.status,
    mode,
    displayPhoneNumber: conn.displayPhoneNumber,
    phoneNumberId: conn.phoneNumberId,
    wabaId: conn.wabaId,
    statusMessage: conn.statusMessage,
    lastVerifiedAt: conn.lastVerifiedAt?.toISOString() ?? null,
    createdAt: conn.createdAt.toISOString(),
  }
}

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
  const {
    organizationId,
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    accessToken,
    verifyToken,
    appSecret,
  } = params

  let status = 'CONNECTING'
  let statusMessage = 'Credentials stored — awaiting verification'

  if (DEV_MODE()) {
    status = 'CONNECTED'
    statusMessage =
      'development-adapter: messages simulated locally until Meta credentials are supplied'
  } else {
    const provider = new MetaWhatsAppProvider(
      accessToken,
      phoneNumberId,
      appSecret,
    )

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
    verifyTokenEncrypted: verifyToken
      ? encryptSecret(verifyToken)
      : null,
    appSecretEncrypted: appSecret
      ? encryptSecret(appSecret)
      : null,
    status,
    statusMessage,
    lastVerifiedAt: status === 'CONNECTED' ? new Date() : null,
  }

  const conn = await db.whatsAppConnection.upsert({
    where: { organizationId },
    create: data,
    update: data,
  })

  log.info('whatsapp.connected', {
    organizationId,
    status,
  })

  await emitToOrganization(
    organizationId,
    'whatsapp.status_changed',
    { status: conn.status },
  )

  return getConnectionSummary(organizationId)
}

export async function disconnectWhatsApp(
  organizationId: string,
): Promise<void> {
  await db.whatsAppConnection.deleteMany({
    where: { organizationId },
  })

  log.info('whatsapp.disconnected', { organizationId })

  await emitToOrganization(
    organizationId,
    'whatsapp.status_changed',
    { status: 'NOT_CONNECTED' },
  )
}

export function providerForConnection(conn: {
  accessTokenEncrypted: string
  phoneNumberId: string
  appSecretEncrypted?: string | null
  statusMessage?: string | null
}): WhatsAppProvider {
  if (conn.statusMessage?.startsWith('waha-adapter')) {
    return new WahaWhatsAppProvider()
  }

  if (conn.statusMessage?.startsWith('development-adapter')) {
    return new DevWhatsAppProvider()
  }

  const accessToken = decryptSecret(conn.accessTokenEncrypted)
  const appSecret = conn.appSecretEncrypted
    ? decryptSecret(conn.appSecretEncrypted)
    : undefined

  return new MetaWhatsAppProvider(
    accessToken,
    conn.phoneNumberId,
    appSecret,
  )
}

export async function providerForOrganization(
  organizationId: string,
): Promise<WhatsAppProvider | null> {
  const conn = await getConnection(organizationId)

  if (!conn) return null

  return providerForConnection(conn)
}

// -----------------------------------------------------------------------------
// WEBHOOK PIPELINE
// -----------------------------------------------------------------------------

export interface WebhookProcessResult {
  accepted: boolean
  reason?: string
  duplicate?: boolean
  processed: number
}

export function verifyWebhook(
  query: URLSearchParams,
): { ok: true; challenge: string } | { ok: false } {
  const mode = query.get('hub.mode')
  const token = query.get('hub.verify_token')
  const challenge = query.get('hub.challenge')
  const expected = process.env.WHATSAPP_VERIFY_TOKEN

  if (
    mode === 'subscribe' &&
    token &&
    challenge &&
    expected &&
    token === expected
  ) {
    return { ok: true, challenge }
  }

  return { ok: false }
}

/**
 * Creates an idempotency event.
 *
 * A processed event is never processed again.
 * An unprocessed event can be retried after a failed attempt.
 *
 * Note: a database-level processing lease would be needed to prevent
 * simultaneous workers from claiming the same unprocessed event.
 */
async function registerWebhookEvent(params: {
  provider: string
  eventId: string
  eventType: string
  payloadHash?: string
}): Promise<boolean> {
  try {
    await db.webhookEvent.create({
      data: {
        provider: params.provider,
        eventId: params.eventId,
        eventType: params.eventType,
        payloadHash: params.payloadHash,
        processed: false,
      },
    })

    return true
  } catch (error) {
    const previous = await db.webhookEvent.findUnique({
      where: { eventId: params.eventId },
      select: { processed: true },
    })

    if (!previous) throw error

    return !previous.processed
  }
}

async function markWebhookProcessed(eventId: string): Promise<void> {
  await db.webhookEvent.update({
    where: { eventId },
    data: {
      processed: true,
      processedAt: new Date(),
      error: null,
    },
  })
}

async function markWebhookFailed(
  eventId: string,
  error: unknown,
): Promise<void> {
  await db.webhookEvent.updateMany({
    where: { eventId },
    data: {
      error: errorMessage(error).slice(0, 500),
    },
  })
}

export async function processWebhookPayload(params: {
  rawBody: string
  signatureHeader: string | null
  payload: unknown
}): Promise<WebhookProcessResult> {
  const { rawBody, signatureHeader, payload } = params

  // Signature verification should be performed by the route using
  // the raw request body before this function is called.
  void signatureHeader
  void verifyWebhookSignature

  const messages = extractInboundMessages(payload)
  const statusUpdates = extractStatusUpdates(payload)

  if (messages.length === 0 && statusUpdates.length === 0) {
    return {
      accepted: false,
      reason: 'no recognized events',
      processed: 0,
    }
  }

  let processed = 0
  let skippedDuplicate = 0

  const payloadHash = sha256Hex(rawBody)

  for (const inbound of messages) {
    const eventId = inbound.whatsappMessageId

    if (!eventId) continue

    try {
      const shouldProcess = await registerWebhookEvent({
        provider: 'WHATSAPP',
        eventId,
        eventType: 'message',
        payloadHash,
      })

      if (!shouldProcess) {
        skippedDuplicate++
        continue
      }

      await handleInboundMessage(inbound)
      await markWebhookProcessed(eventId)

      processed++
    } catch (error) {
      log.error('webhook.process_failed', {
        eventId,
        message: errorMessage(error),
      })

      await markWebhookFailed(eventId, error)
    }
  }

  const statusMap: Record<string, string> = {
    SENT: 'SENT',
    DELIVERED: 'DELIVERED',
    READ: 'READ',
    FAILED: 'FAILED',
  }

  for (const statusUpdate of statusUpdates) {
    const mapped = statusMap[statusUpdate.status.toUpperCase()]

    if (!mapped) continue

    await db.message.updateMany({
      where: {
        whatsappMessageId: statusUpdate.whatsappMessageId,
      },
      data: {
        status: mapped,
      },
    })
  }

  return {
    accepted: true,
    duplicate: skippedDuplicate > 0 && processed === 0,
    processed,
  }
}

// -----------------------------------------------------------------------------
// LEGACY INBOUND MESSAGE HANDLER — META / WAHA / DEVELOPMENT
// -----------------------------------------------------------------------------

async function handleInboundMessage(
  inbound: {
    phoneNumberId: string
    from: string
    profileName?: string
    whatsappMessageId: string
    timestamp: Date
    type: string
    text?: string
    mediaId?: string
    mediaMimeType?: string
  },
): Promise<void> {
  const connection = await db.whatsAppConnection.findUnique({
    where: { phoneNumberId: inbound.phoneNumberId },
  })

  if (!connection) {
    log.warn('webhook.unknown_phone_number_id', {
      phoneNumberId: inbound.phoneNumberId,
    })

    throw new Error('Unknown WhatsApp phone number ID')
  }

  const organizationId = connection.organizationId
  const safeTimestamp = safeDate(inbound.timestamp)
  const actualText = inbound.text?.trim() || ''

  const content =
    actualText ||
    (inbound.mediaId
      ? `[${inbound.type.toLowerCase()} attachment received]`
      : `[${inbound.type.toLowerCase()} message received]`)

  let result: {
    conversation: { id: string }
    message: { id: string }
    customer: { id: string; name: string | null }
  }

  try {
    result = await db.$transaction(async (tx) => {
      const customer = await tx.customer.upsert({
        where: {
          organizationId_phoneNumber: {
            organizationId,
            phoneNumber: inbound.from,
          },
        },
        create: {
          organizationId,
          phoneNumber: inbound.from,
          whatsappId: inbound.from,
          name: inbound.profileName ?? null,
        },
        update: inbound.profileName
          ? { name: inbound.profileName }
          : {},
      })

      const existing = await tx.conversation.findFirst({
        where: {
          organizationId,
          customerId: customer.id,
          whatsappConnectionId: connection.id,
          status: 'OPEN',
        },
        orderBy: { lastMessageAt: 'desc' },
      })

      const conversation = existing
        ? await tx.conversation.update({
            where: { id: existing.id },
            data: { lastMessageAt: safeTimestamp },
          })
        : await tx.conversation.create({
            data: {
              organizationId,
              customerId: customer.id,
              whatsappConnectionId: connection.id,
              status: 'OPEN',
              lastMessageAt: safeTimestamp,
            },
          })

      const message = await tx.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          whatsappMessageId: inbound.whatsappMessageId,
          senderType: 'CUSTOMER',
          senderId: customer.id,
          messageType: (inbound.type || 'TEXT').toUpperCase(),
          content,
          mediaUrl: null,
          mediaMimeType: inbound.mediaMimeType ?? null,
          direction: 'INBOUND',
          status: 'RECEIVED',
          createdAt: safeTimestamp,
        },
      })

      return { conversation, message, customer }
    })
  } catch (error) {
    // A duplicate external message ID must not create another message.
    if (isPrismaUniqueError(error)) {
      log.info('whatsapp.inbound_duplicate_message', {
        messageId: inbound.whatsappMessageId,
      })
      return
    }

    throw error
  }

  const { conversation, message, customer } = result

  await emitToOrganization(
    organizationId,
    'message.created',
    {
      conversationId: conversation.id,
      messageId: message.id,
    },
  )

  try {
    const provider = providerForConnection(connection)
    await provider.markMessageRead(inbound.whatsappMessageId)
  } catch (error) {
    log.warn('whatsapp.mark_read_failed', {
      messageId: inbound.whatsappMessageId,
      error: errorMessage(error),
    })
  }

  if (actualText) {
    await processBotMessage({
      organizationId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerName: customer.name,
      text: actualText,
    })
  } else if (inbound.mediaId || inbound.type !== 'text') {
    await sendBotReply(
      organizationId,
      conversation.id,
      `Thank you. We have received your ${inbound.type.toLowerCase()} attachment.

Could you briefly describe the issue or tell us how we can help you?`,
    )
  }
}

// -----------------------------------------------------------------------------
// BAILEYS INBOUND PIPELINE — MULTI-ACCOUNT
// -----------------------------------------------------------------------------

export async function processBaileysInbound(input: {
  accountId: string
  from: string
  profileName?: string | null
  whatsappMessageId: string
  timestamp: string
  messageType?: string
  text?: string
  mediaMimeType?: string | null
}) {
  if (
    !input.accountId?.trim() ||
    !input.from?.trim() ||
    !input.whatsappMessageId?.trim()
  ) {
    throw new Error('Invalid Baileys inbound message')
  }

  const account = await db.whatsAppAccount.findUnique({
    where: { id: input.accountId },
  })

  if (!account) {
    throw new Error('Unknown WhatsApp account')
  }

  const eventId =
    `BAILEYS:${account.id}:${input.whatsappMessageId}`

  const shouldProcess = await registerWebhookEvent({
    provider: 'BAILEYS',
    eventId,
    eventType: 'message',
  })

  if (!shouldProcess) {
    return {
      accepted: true,
      duplicate: true,
    }
  }

  const safeTimestamp = safeDate(input.timestamp)
  const actualText = input.text?.trim() || ''
  const messageType = (input.messageType || 'TEXT').toUpperCase()

  const content =
    actualText ||
    (messageType !== 'TEXT'
      ? `[${messageType.toLowerCase()} attachment received]`
      : '[Empty message received]')

  try {
    const result = await db.$transaction(async (tx) => {
      const customer = await tx.customer.upsert({
        where: {
          organizationId_phoneNumber: {
            organizationId: account.organizationId,
            phoneNumber: input.from,
          },
        },
        create: {
          organizationId: account.organizationId,
          phoneNumber: input.from,
          whatsappId: input.from,
          name: input.profileName || null,
        },
        update: input.profileName
          ? { name: input.profileName }
          : {},
      })

      const existing = await tx.conversation.findFirst({
        where: {
          organizationId: account.organizationId,
          customerId: customer.id,
          whatsappAccountId: account.id,
          status: 'OPEN',
        },
        orderBy: { lastMessageAt: 'desc' },
      })

      const conversation = existing
        ? await tx.conversation.update({
            where: { id: existing.id },
            data: { lastMessageAt: safeTimestamp },
          })
        : await tx.conversation.create({
            data: {
              organizationId: account.organizationId,
              customerId: customer.id,
              whatsappAccountId: account.id,
              status: 'OPEN',
              lastMessageAt: safeTimestamp,
            },
          })

      const message = await tx.message.create({
        data: {
          organizationId: account.organizationId,
          conversationId: conversation.id,
          whatsappMessageId: input.whatsappMessageId,
          senderType: 'CUSTOMER',
          senderId: customer.id,
          messageType,
          content,
          mediaUrl: null,
          mediaMimeType: input.mediaMimeType ?? null,
          direction: 'INBOUND',
          status: 'RECEIVED',
          createdAt: safeTimestamp,
        },
      })

      return { conversation, message, customer }
    })

    // The message is safely persisted before bot processing.
    await markWebhookProcessed(eventId)

    await emitToOrganization(
      account.organizationId,
      'message.created',
      {
        conversationId: result.conversation.id,
        messageId: result.message.id,
      },
    )

    if (actualText) {
      await processBotMessage({
        organizationId: account.organizationId,
        conversationId: result.conversation.id,
        customerId: result.customer.id,
        customerName: result.customer.name,
        text: actualText,
      })
    } else if (messageType !== 'TEXT') {
      await sendBotReply(
        account.organizationId,
        result.conversation.id,
        `Thank you. We have received your ${messageType.toLowerCase()} attachment.

Please describe what you need help with so I can assist you.`,
      )
    }

    return {
      accepted: true,
      duplicate: false,
      conversationId: result.conversation.id,
      messageId: result.message.id,
    }
  } catch (error) {
    const message = errorMessage(error)

    // If the message ID already exists, do not create a second message.
    if (isPrismaUniqueError(error)) {
      await markWebhookProcessed(eventId)

      log.info('baileys.duplicate_message', {
        accountId: account.id,
        messageId: input.whatsappMessageId,
      })

      return {
        accepted: true,
        duplicate: true,
      }
    }

    log.error('baileys.inbound_failed', {
      accountId: input.accountId,
      messageId: input.whatsappMessageId,
      eventId,
      error: message,
    })

    await markWebhookFailed(eventId, error)

    throw error
  }
}

// -----------------------------------------------------------------------------
// BOT MESSAGE PROCESSING
// -----------------------------------------------------------------------------

async function processBotMessage(params: {
  organizationId: string
  conversationId: string
  customerId: string
  customerName: string | null
  text: string
}): Promise<void> {
  const text = params.text.trim()

  if (!text) return

  try {
    const reply = await handleCustomerMessage({
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      customerId: params.customerId,
      customerName: params.customerName,
      text,
    })

    if (!reply.text?.trim()) return

    await sendBotReply(
      params.organizationId,
      params.conversationId,
      reply.text,
    )
  } catch (error) {
    log.error('whatsapp.bot_processing_failed', {
      conversationId: params.conversationId,
      error: errorMessage(error),
    })
  }
}

// -----------------------------------------------------------------------------
// OUTBOUND MESSAGE ROUTING — BAILEYS + LEGACY PROVIDERS
// -----------------------------------------------------------------------------

export async function sendOutbound(params: {
  organizationId: string
  conversationId: string
  to: string
  text: string
  senderType?: 'BOT' | 'STAFF' | 'SYSTEM'
  senderId?: string
}): Promise<{
  ok: boolean
  messageId?: string
  error?: string
}> {
  const text = params.text.trim()

  if (!text) {
    return { ok: false, error: 'Message cannot be empty' }
  }

  const conversation = await db.conversation.findFirst({
    where: {
      id: params.conversationId,
      organizationId: params.organizationId,
    },
    select: {
      id: true,
      whatsappAccountId: true,
    },
  })

  if (!conversation) {
    return { ok: false, error: 'Conversation not found' }
  }

  let accountId = conversation.whatsappAccountId

  // Legacy conversations can be assigned an account only if exactly
  // one connected account exists. Never select an arbitrary account.
  if (!accountId) {
    const available = await db.whatsAppAccount.findMany({
      where: {
        organizationId: params.organizationId,
        status: 'CONNECTED',
      },
      select: { id: true },
      take: 2,
    })

    if (available.length === 1) {
      accountId = available[0].id

      await db.conversation.update({
        where: { id: conversation.id },
        data: { whatsappAccountId: accountId },
      })
    }
  }

  // ---------------------------------------------------------------------------
  // BAILEYS OUTBOUND
  // ---------------------------------------------------------------------------

  if (accountId) {
    const account = await db.whatsAppAccount.findFirst({
      where: {
        id: accountId,
        organizationId: params.organizationId,
      },
    })

    const record = await db.message.create({
      data: {
        organizationId: params.organizationId,
        conversationId: params.conversationId,
        senderType: params.senderType ?? 'SYSTEM',
        senderId: params.senderId,
        messageType: 'TEXT',
        content: text,
        direction: 'OUTBOUND',
        status: 'FAILED',
      },
    })

    if (!account || account.status !== 'CONNECTED') {
      await emitToOrganization(
        params.organizationId,
        'message.created',
        {
          conversationId: params.conversationId,
          messageId: record.id,
        },
      )

      return {
        ok: false,
        error: 'The WhatsApp account assigned to this conversation is not connected',
      }
    }

    try {
      const result = await callBaileysWorker(
        `/sessions/${encodeURIComponent(account.id)}/send`,
        {
          method: 'POST',
          body: JSON.stringify({
            to: normalizePhoneNumber(params.to),
            text,
          }),
        },
      )

      await db.message.update({
        where: { id: record.id },
        data: {
          status: 'SENT',
          whatsappMessageId: result.messageId ?? null,
        },
      })

      await emitToOrganization(
        params.organizationId,
        'message.created',
        {
          conversationId: params.conversationId,
          messageId: record.id,
        },
      )

      return {
        ok: true,
        messageId: result.messageId,
      }
    } catch (error) {
      const message = errorMessage(error)

      await db.message.update({
        where: { id: record.id },
        data: { status: 'FAILED' },
      })

      await emitToOrganization(
        params.organizationId,
        'message.created',
        {
          conversationId: params.conversationId,
          messageId: record.id,
        },
      )

      log.error('whatsapp.baileys_send_failed', {
        accountId,
        conversationId: params.conversationId,
        error: message,
      })

      return {
        ok: false,
        error: message,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // LEGACY META / WAHA / DEVELOPMENT OUTBOUND
  // ---------------------------------------------------------------------------

  const conn = await getConnection(params.organizationId)

  const record = await db.message.create({
    data: {
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      senderType: params.senderType ?? 'SYSTEM',
      senderId: params.senderId,
      messageType: 'TEXT',
      content: text,
      direction: 'OUTBOUND',
      status: 'FAILED',
    },
  })

  if (!conn) {
    await emitToOrganization(
      params.organizationId,
      'message.created',
      {
        conversationId: params.conversationId,
        messageId: record.id,
      },
    )

    return { ok: false, error: 'WhatsApp not connected' }
  }

  try {
    const provider = providerForConnection(conn)

    const result = await provider.sendTextMessage(
      normalizePhoneNumber(params.to),
      text,
    )

    await db.message.update({
      where: { id: record.id },
      data: {
        status: result.ok ? 'SENT' : 'FAILED',
        whatsappMessageId: result.messageId ?? null,
      },
    })

    await emitToOrganization(
      params.organizationId,
      'message.created',
      {
        conversationId: params.conversationId,
        messageId: record.id,
      },
    )

    return result
  } catch (error) {
    const message = errorMessage(error)

    await db.message.update({
      where: { id: record.id },
      data: { status: 'FAILED' },
    })

    await emitToOrganization(
      params.organizationId,
      'message.created',
      {
        conversationId: params.conversationId,
        messageId: record.id,
      },
    )

    log.error('whatsapp.legacy_send_failed', {
      conversationId: params.conversationId,
      error: message,
    })

    return {
      ok: false,
      error: message,
    }
  }
}

// -----------------------------------------------------------------------------
// BOT REPLY
// -----------------------------------------------------------------------------

async function sendBotReply(
  organizationId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  if (!text.trim()) return

  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      organizationId,
    },
    select: {
      customer: {
        select: { phoneNumber: true },
      },
    },
  })

  if (!conversation) {
    log.warn('whatsapp.bot_reply_conversation_missing', {
      conversationId,
    })

    return
  }

  const to = conversation.customer.phoneNumber

  if (!to) {
    log.warn('whatsapp.bot_reply_customer_number_missing', {
      conversationId,
    })

    return
  }

  const result = await sendOutbound({
    organizationId,
    conversationId,
    to,
    text,
    senderType: 'BOT',
  })

  if (!result.ok) {
    log.error('whatsapp.bot_reply_delivery_failed', {
      conversationId,
      error: result.error,
    })
  }
}

// -----------------------------------------------------------------------------
// DEVELOPMENT ADAPTER HELPERS
// -----------------------------------------------------------------------------

export function isDevelopmentMode(): boolean {
  return DEV_MODE()
}

export async function simulateInboundMessage(params: {
  organizationId: string
  from: string
  text: string
  profileName?: string
}): Promise<WebhookProcessResult> {
  if (!DEV_MODE()) {
    return {
      accepted: false,
      reason: 'simulation disabled in production mode',
      processed: 0,
    }
  }

  const conn = await getConnection(params.organizationId)

  if (!conn) {
    return {
      accepted: false,
      reason: 'Connect WhatsApp first (development adapter)',
      processed: 0,
    }
  }

  const { payload } = buildSimulatedWebhook({
    phoneNumberId: conn.phoneNumberId,
    from: params.from,
    text: params.text,
    profileName: params.profileName,
  })

  const rawBody = JSON.stringify(payload)

  return processWebhookPayload({
    rawBody,
    signatureHeader: null,
    payload,
  })
}

export { verifyWebhookSignature }
