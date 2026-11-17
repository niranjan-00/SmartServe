
import { db } from '@/lib/db'

import {
  encryptSecret,
  decryptSecret,
  randomToken,
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
import { DevWhatsAppProvider, buildSimulatedWebhook } from './dev-provider'
import { WahaWhatsAppProvider } from './waha-provider'
import { handleCustomerMessage } from './bot'
import { callBaileysWorker } from './baileys-client'

const log = createLogger('whatsapp')

/**
 * WhatsAppService
 *
 * Supports:
 * - Meta WhatsApp Cloud API
 * - Development adapter
 * - WAHA legacy integration
 * - Baileys multi-account integration
 *
 * Incoming messages are persisted before bot processing.
 * Outgoing bot messages are persisted and delivered through
 * the provider assigned to the conversation.
 */

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

/**
 * Connect Meta WhatsApp Cloud API credentials.
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
    {
      status: conn.status,
    },
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
    {
      status: 'NOT_CONNECTED',
    },
  )
}

/**
 * Builds the correct legacy provider for a stored connection.
 */
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

// ---------------------------------------------------------------------------
// WEBHOOK PIPELINE — META / WAHA / DEVELOPMENT
// ---------------------------------------------------------------------------

export interface WebhookProcessResult {
  accepted: boolean
  reason?: string
  duplicate?: boolean
  processed: number
}

/**
 * GET verification for Meta's webhook challenge.
 */
export function verifyWebhook(
  query: URLSearchParams,
): { ok: true; challenge: string } | { ok: false } {
  const mode = query.get('hub.mode')
  const token = query.get('hub.verify_token')
  const challenge = query.get('hub.challenge')
  const expected = process.env.WHATSAPP_VERIFY_TOKEN

  if (mode === 'subscribe' && token && challenge && expected) {
    if (token === expected) {
      return {
        ok: true,
        challenge,
      }
    }
  }

  return { ok: false }
}

/**
 * Creates an idempotency record.
 *
 * If an event was previously received but not processed,
 * it can be retried.
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
      where: {
        eventId: params.eventId,
      },
      select: {
        processed: true,
      },
    })

    if (!previous) {
      throw error
    }

    if (previous.processed) {
      return false
    }

    // Previous attempt failed before completion.
    // Allow this event to be retried.
    return true
  }
}

/**
 * Persists incoming legacy WhatsApp webhook events.
 */
export async function processWebhookPayload(params: {
  rawBody: string
  signatureHeader: string | null
  payload: unknown
}): Promise<WebhookProcessResult> {
  const {
    rawBody,
    signatureHeader,
    payload,
  } = params

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

      await db.webhookEvent.update({
        where: { eventId },
        data: {
          processed: true,
          processedAt: new Date(),
          error: null,
        },
      })

      processed++
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error)

      log.error('webhook.process_failed', {
        eventId,
        message,
      })

      await db.webhookEvent.updateMany({
        where: { eventId },
        data: {
          error: message.slice(0, 500),
        },
      })
    }
  }

  const statusMap: Record<string, string> = {
    SENT: 'SENT',
    DELIVERED: 'DELIVERED',
    READ: 'READ',
    FAILED: 'FAILED',
  }

  for (const statusUpdate of statusUpdates) {
    const mapped =
      statusMap[statusUpdate.status.toUpperCase()]

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

  // Signature verification is handled by the webhook route.
  void signatureHeader
  void verifyWebhookSignature

  return {
    accepted: true,
    duplicate: skippedDuplicate > 0 && processed === 0,
    processed,
  }
}

/**
 * Handles one incoming legacy provider message.
 */
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
    where: {
      phoneNumberId: inbound.phoneNumberId,
    },
  })

  if (!connection) {
    log.warn('webhook.unknown_phone_number_id', {
      phoneNumberId: inbound.phoneNumberId,
    })

    throw new Error('Unknown WhatsApp phone number ID')
  }

  const organizationId = connection.organizationId

  const safeTimestamp =
    inbound.timestamp instanceof Date &&
    !Number.isNaN(inbound.timestamp.getTime())
      ? inbound.timestamp
      : new Date()

  const actualText = inbound.text?.trim() || ''

  const content =
    actualText ||
    (inbound.mediaId
      ? `[${inbound.type.toLowerCase()} attachment received]`
      : '')

  const { conversation, message, customer } =
    await db.$transaction(async (tx) => {
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
        orderBy: {
          lastMessageAt: 'desc',
        },
      })

      const conversation = existing
        ? await tx.conversation.update({
            where: { id: existing.id },
            data: {
              lastMessageAt: safeTimestamp,
            },
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
          messageType: inbound.type || 'TEXT',
          content,
          mediaUrl: null,
          mediaMimeType: inbound.mediaMimeType ?? null,
          direction: 'INBOUND',
          status: 'RECEIVED',
          createdAt: safeTimestamp,
        },
      })

      return {
        conversation,
        message,
        customer,
      }
    })

  await emitToOrganization(
    organizationId,
    'message.created',
    {
      conversationId: conversation.id,
      messageId: message.id,
    },
  )

  // Read receipts are best effort.
  try {
    const provider = providerForConnection(connection)

    await provider.markMessageRead(
      inbound.whatsappMessageId,
    )
  } catch (error) {
    log.warn('whatsapp.mark_read_failed', {
      messageId: inbound.whatsappMessageId,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    })
  }

  // Process actual text messages through the bot.
  // Do not send a complaint flow a fake attachment placeholder.
  if (actualText) {
    await processBotMessage({
      organizationId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerName: customer.name,
      text: actualText,
    })
  } else if (inbound.mediaId) {
    await sendBotReply(
      organizationId,
      conversation.id,
      `I received your ${inbound.type.toLowerCase()} attachment. 📎

Could you briefly describe the issue or explain what you need help with?`,
    )
  }
}

// ---------------------------------------------------------------------------
// BAILEYS INBOUND PIPELINE — MULTI-ACCOUNT
// ---------------------------------------------------------------------------

/**
 * Processes an inbound event received from the dedicated Baileys worker.
 *
 * The worker must provide a real customer phone number in "from".
 * Do not convert an unresolved WhatsApp @lid value into a fake number.
 */
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
    !input.accountId ||
    !input.from ||
    !input.whatsappMessageId
  ) {
    throw new Error('Invalid Baileys inbound message')
  }

  const account = await db.whatsAppAccount.findUnique({
    where: {
      id: input.accountId,
    },
  })

  if (!account) {
    throw new Error('Unknown WhatsApp account')
  }

  const shouldProcess = await registerWebhookEvent({
    provider: 'BAILEYS',
    eventId: input.whatsappMessageId,
    eventType: 'message',
  })

  if (!shouldProcess) {
    return {
      accepted: true,
      duplicate: true,
    }
  }

  const parsedTimestamp = new Date(input.timestamp)

  const safeTimestamp = Number.isNaN(parsedTimestamp.getTime())
    ? new Date()
    : parsedTimestamp

  const actualText = input.text?.trim() || ''

  const messageType = input.messageType || 'TEXT'

  const content =
    actualText ||
    (messageType.toUpperCase() !== 'TEXT'
      ? `[${messageType.toLowerCase()} attachment received]`
      : '')

  try {
    const { conversation, message, customer } =
      await db.$transaction(async (tx) => {
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
          orderBy: {
            lastMessageAt: 'desc',
          },
        })

        const conversation = existing
          ? await tx.conversation.update({
              where: {
                id: existing.id,
              },
              data: {
                lastMessageAt: safeTimestamp,
              },
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

        return {
          conversation,
          message,
          customer,
        }
      })

    // The message is safely persisted. Mark the inbound event processed
    // before bot execution so a retry does not create a duplicate message.
    await db.webhookEvent.update({
      where: {
        eventId: input.whatsappMessageId,
      },
      data: {
        processed: true,
        processedAt: new Date(),
        error: null,
      },
    })

    await emitToOrganization(
      account.organizationId,
      'message.created',
      {
        conversationId: conversation.id,
        messageId: message.id,
      },
    )

    // Process only genuine customer messages.
    if (actualText) {
      await processBotMessage({
        organizationId: account.organizationId,
        conversationId: conversation.id,
        customerId: customer.id,
        customerName: customer.name,
        text: actualText,
      })
    } else if (messageType.toUpperCase() !== 'TEXT') {
      await sendBotReply(
        account.organizationId,
        conversation.id,
        `I received your ${messageType.toLowerCase()} attachment. 📎

Please describe what you need help with so I can assist you.`,
      )
    }

    return {
      accepted: true,
      duplicate: false,
      conversationId: conversation.id,
      messageId: message.id,
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'Inbound processing failed'

    log.error('baileys.inbound_failed', {
      accountId: input.accountId,
      messageId: input.whatsappMessageId,
      error: errorMessage,
    })

    await db.webhookEvent.updateMany({
      where: {
        eventId: input.whatsappMessageId,
      },
      data: {
        error: errorMessage.slice(0, 500),
      },
    })

    throw error
  }
}

// ---------------------------------------------------------------------------
// BOT MESSAGE PROCESSING
// ---------------------------------------------------------------------------

/**
 * Executes the bot and sends its reply.
 *
 * Bot errors must not delete or undo the already-saved inbound message.
 */
async function processBotMessage(params: {
  organizationId: string
  conversationId: string
  customerId: string
  customerName: string | null
  text: string
}): Promise<void> {
  try {
    const reply = await handleCustomerMessage({
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      customerId: params.customerId,
      customerName: params.customerName,
      text: params.text,
    })

    if (!reply.text?.trim()) {
      return
    }

    await sendBotReply(
      params.organizationId,
      params.conversationId,
      reply.text,
    )
  } catch (error) {
    log.error('whatsapp.bot_processing_failed', {
      conversationId: params.conversationId,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    })
  }
}

// ---------------------------------------------------------------------------
// OUTBOUND MESSAGE ROUTING — BAILEYS + LEGACY PROVIDERS
// ---------------------------------------------------------------------------

/**
 * Routes outgoing messages:
 *
 * 1. Baileys when the conversation has a WhatsApp account.
 * 2. Legacy Meta / WAHA / development when it has a legacy connection.
 *
 * Every outgoing message is stored in the SmartServe database.
 */
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
  if (!params.text.trim()) {
    return {
      ok: false,
      error: 'Message cannot be empty',
    }
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
    return {
      ok: false,
      error: 'Conversation not found',
    }
  }

  let accountId = conversation.whatsappAccountId

  // Backward-compatible routing for old conversations.
  // Never choose randomly when multiple Baileys accounts exist.
  if (!accountId) {
    const available = await db.whatsAppAccount.findMany({
      where: {
        organizationId: params.organizationId,
        status: 'CONNECTED',
      },
      select: {
        id: true,
      },
      take: 2,
    })

    if (available.length === 1) {
      accountId = available[0].id

      await db.conversation.update({
        where: {
          id: params.conversationId,
        },
        data: {
          whatsappAccountId: accountId,
        },
      })
    }
  }

  // ---------------------------------------------------------
  // BAILEYS ROUTE
  // ---------------------------------------------------------

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
        content: params.text,
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
            to: params.to,
            text: params.text,
          }),
        },
      )

      await db.message.update({
        where: {
          id: record.id,
        },
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
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Baileys could not send the message'

      await db.message.update({
        where: {
          id: record.id,
        },
        data: {
          status: 'FAILED',
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

      log.error('whatsapp.baileys_send_failed', {
        accountId,
        conversationId: params.conversationId,
        error: errorMessage,
      })

      return {
        ok: false,
        error: errorMessage,
      }
    }
  }

  // ---------------------------------------------------------
  // LEGACY META / WAHA / DEVELOPMENT ROUTE
  // ---------------------------------------------------------

  const conn = await getConnection(params.organizationId)

  const record = await db.message.create({
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

  if (!conn) {
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
      error: 'WhatsApp not connected',
    }
  }

  try {
    const provider = providerForConnection(conn)

    const result = await provider.sendTextMessage(
      params.to,
      params.text,
    )

    await db.message.update({
      where: {
        id: record.id,
      },
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
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'WhatsApp provider failed'

    await db.message.update({
      where: {
        id: record.id,
      },
      data: {
        status: 'FAILED',
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

    log.error('whatsapp.legacy_send_failed', {
      conversationId: params.conversationId,
      error: errorMessage,
    })

    return {
      ok: false,
      error: errorMessage,
    }
  }
}

// ---------------------------------------------------------------------------
// BOT REPLY
// ---------------------------------------------------------------------------

/**
 * Sends a bot response to the customer associated with a conversation.
 */
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
        select: {
          phoneNumber: true,
        },
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

// ---------------------------------------------------------------------------
// DEVELOPMENT ADAPTER HELPERS
// ---------------------------------------------------------------------------

export function isDevelopmentMode(): boolean {
  return DEV_MODE()
}

/**
 * Simulates an inbound message through the normal webhook pipeline.
 */
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
