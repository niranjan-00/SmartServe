
import { db } from '@/lib/db'

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

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const DEV_MODE = () =>
  (process.env.WHATSAPP_MODE || 'development') !== 'production'

const MAX_MESSAGE_LENGTH = 4000

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

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

export interface WebhookProcessResult {
  accepted: boolean
  reason?: string
  duplicate?: boolean
  processed: number
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

function safeDate(value: string | Date | undefined | null): Date {
  if (!value) return new Date()

  const date = value instanceof Date
    ? value
    : new Date(value)

  return Number.isNaN(date.getTime())
    ? new Date()
    : date
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

function normalizeMessageType(value?: string): string {
  const type = (value || 'TEXT').toUpperCase()

  const supported = new Set([
    'TEXT',
    'IMAGE',
    'VIDEO',
    'AUDIO',
    'DOCUMENT',
    'STICKER',
    'LOCATION',
    'CONTACT',
    'BUTTON',
    'INTERACTIVE',
    'UNKNOWN',
  ])

  return supported.has(type) ? type : 'UNKNOWN'
}

function buildMessageContent(
  text: string | undefined,
  messageType: string,
): string {
  const cleanText = text?.trim()

  if (cleanText) {
    return cleanText.slice(0, MAX_MESSAGE_LENGTH)
  }

  if (messageType === 'TEXT') {
    return '[Empty message received]'
  }

  return `[${messageType.toLowerCase()} attachment received]`
}

async function emitMessageCreated(
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  try {
    await emitToOrganization(
      organizationId,
      'message.created',
      {
        conversationId,
        messageId,
      },
    )
  } catch (error) {
    log.error('whatsapp.realtime_emit_failed', {
      conversationId,
      messageId,
      error: errorMessage(error),
    })
  }
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

  if (
    !organizationId.trim() ||
    !wabaId.trim() ||
    !phoneNumberId.trim() ||
    !accessToken.trim()
  ) {
    throw new Error('Organization, WABA, phone number ID, and access token are required')
  }

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
// WEBHOOK VERIFICATION
// -----------------------------------------------------------------------------

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
    return {
      ok: true,
      challenge,
    }
  }

  return { ok: false }
}

// -----------------------------------------------------------------------------
// WEBHOOK EVENT IDEMPOTENCY
// -----------------------------------------------------------------------------

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
    if (!isPrismaUniqueError(error)) {
      throw error
    }

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

    // Allow retry if the previous attempt failed.
    return !previous.processed
  }
}

async function markWebhookProcessed(
  eventId: string,
): Promise<void> {
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

// -----------------------------------------------------------------------------
// META / WAHA / DEVELOPMENT WEBHOOK PROCESSING
// -----------------------------------------------------------------------------

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

  // Signature validation must be performed by the HTTP route
  // using the original raw request body.
  void signatureHeader
  void verifyWebhookSignature

  const messages = extractInboundMessages(payload)
  const statusUpdates = extractStatusUpdates(payload)

  if (messages.length === 0 && statusUpdates.length === 0) {
    return {
      accepted: false,
      reason: 'No recognized WhatsApp events',
      processed: 0,
    }
  }

  let processed = 0
  let skippedDuplicate = 0
  const failures: string[] = []

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
        error: errorMessage(error),
      })

      failures.push(`${eventId}: ${errorMessage(error)}`)

      try {
        await markWebhookFailed(eventId, error)
      } catch (markError) {
        log.error('webhook.failure_record_failed', {
          eventId,
          error: errorMessage(markError),
        })
      }
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

    try {
      await db.message.updateMany({
        where: {
          whatsappMessageId: statusUpdate.whatsappMessageId,
        },
        data: {
          status: mapped,
        },
      })
    } catch (error) {
      const message = errorMessage(error)
      failures.push(`${statusUpdate.whatsappMessageId}: ${message}`)

      log.error('whatsapp.status_update_failed', {
        messageId: statusUpdate.whatsappMessageId,
        error: message,
      })
    }
  }

  // Return a non-2xx response through the API route if any event failed.
  // Providers can then retry; already-processed events remain idempotent.
  if (failures.length > 0) {
    throw new Error(
      `WhatsApp webhook processing failed for ${failures.length} event(s): ${failures.join(' | ').slice(0, 1500)}`,
    )
  }

  return {
    accepted: true,
    duplicate: skippedDuplicate > 0 && processed === 0,
    processed,
  }
}

// -----------------------------------------------------------------------------
// LEGACY INBOUND MESSAGE HANDLER
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
    where: {
      phoneNumberId: inbound.phoneNumberId,
    },
  })

  if (!connection) {
    throw new Error('Unknown WhatsApp phone number ID')
  }

  const organizationId = connection.organizationId
  const safeTimestamp = safeDate(inbound.timestamp)
  const messageType = normalizeMessageType(inbound.type)

  const content = buildMessageContent(
    inbound.text,
    messageType,
  )

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
        orderBy: {
          lastMessageAt: 'desc',
        },
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
          messageType,
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
  } catch (error) {
    if (!isPrismaUniqueError(error)) {
      throw error
    }

    // The message may already be stored from an earlier attempt whose bot
    // reply failed. Recover it so the webhook retry can continue processing.
    const existingMessage = await db.message.findUnique({
      where: {
        whatsappMessageId: inbound.whatsappMessageId,
      },
      include: {
        conversation: {
          include: {
            customer: true,
          },
        },
      },
    })

    if (!existingMessage) {
      throw error
    }

    if (
      existingMessage.conversation.whatsappConnectionId !== connection.id
    ) {
      throw new Error(
        'Existing message belongs to a different WhatsApp connection',
      )
    }

    result = {
      conversation: existingMessage.conversation,
      message: existingMessage,
      customer: existingMessage.conversation.customer,
    }

    log.info('whatsapp.existing_message_recovered', {
      messageId: inbound.whatsappMessageId,
      conversationId: result.conversation.id,
    })
  }

  await emitMessageCreated(
    organizationId,
    result.conversation.id,
    result.message.id,
  )

  try {
    const provider = providerForConnection(connection)

    await provider.markMessageRead(
      inbound.whatsappMessageId,
    )
  } catch (error) {
    log.warn('whatsapp.mark_read_failed', {
      messageId: inbound.whatsappMessageId,
      error: errorMessage(error),
    })
  }

  if (inbound.text?.trim()) {
    await processBotMessage({
      organizationId,
      conversationId: result.conversation.id,
      customerId: result.customer.id,
      customerName: result.customer.name,
      text: inbound.text,
    })
  } else if (inbound.mediaId || messageType !== 'TEXT') {
    await sendBotReply(
      organizationId,
      result.conversation.id,
      `Thank you. We have received your ${messageType.toLowerCase()} attachment.

Could you briefly describe the issue or tell us how we can help you?`,
    )
  }
}

// -----------------------------------------------------------------------------
// BAILEYS INBOUND MESSAGE PROCESSING
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
    !input.whatsappMessageId?.trim() ||
    input.whatsappMessageId.length > 512 ||
    input.from.length > 64
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
      conversationId: null,
      messageId: null,
    }
  }

  const safeTimestamp = safeDate(input.timestamp)
  const messageType = normalizeMessageType(input.messageType)

  const actualText = input.text?.trim() || ''

  const content = buildMessageContent(
    actualText,
    messageType,
  )

  try {
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
    } catch (error) {
      if (!isPrismaUniqueError(error)) {
        throw error
      }

      // Important:
      // The inbound message might already have been persisted by a
      // previous attempt whose bot processing failed.
      //
      // Recover the existing message instead of abandoning the bot.

      const existingMessage = await db.message.findUnique({
        where: {
          whatsappMessageId: input.whatsappMessageId,
        },
        include: {
          conversation: {
            include: {
              customer: true,
            },
          },
        },
      })

      if (!existingMessage) {
        throw error
      }

      if (
        existingMessage.conversation.whatsappAccountId !== account.id
      ) {
        throw new Error(
          'Existing message belongs to a different WhatsApp account',
        )
      }

      result = {
        conversation: existingMessage.conversation,
        message: existingMessage,
        customer: existingMessage.conversation.customer,
      }

      log.info('baileys.existing_message_recovered', {
        accountId: account.id,
        messageId: input.whatsappMessageId,
        conversationId: result.conversation.id,
      })
    }

    // Message is persisted before bot execution.
    // This event is emitted even if the bot subsequently fails.

    await emitMessageCreated(
      account.organizationId,
      result.conversation.id,
      result.message.id,
    )

    // Do not mark the event processed yet.
    // If the bot fails, the worker can retry this event.

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

    // Only acknowledge successful processing after bot handling.
    await markWebhookProcessed(eventId)

    log.info('baileys.inbound_processed', {
      accountId: account.id,
      messageId: input.whatsappMessageId,
      conversationId: result.conversation.id,
      messageType,
      hasText: Boolean(actualText),
    })

    return {
      accepted: true,
      duplicate: false,
      conversationId: result.conversation.id,
      messageId: result.message.id,
    }
  } catch (error) {
    log.error('baileys.inbound_failed', {
      accountId: account.id,
      messageId: input.whatsappMessageId,
      eventId,
      error: errorMessage(error),
    })

    try {
      await markWebhookFailed(eventId, error)
    } catch (markError) {
      log.error('baileys.webhook_failure_record_failed', {
        eventId,
        error: errorMessage(markError),
      })
    }

    // IMPORTANT:
    // Throw the error so the worker knows processing failed.
    // Returning success here would permanently lose retry opportunities.

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

  log.info('whatsapp.bot_processing_started', {
    conversationId: params.conversationId,
    customerId: params.customerId,
  })

  try {
    const reply = await handleCustomerMessage({
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      customerId: params.customerId,
      customerName: params.customerName,
      text,
    })

    if (!reply?.text?.trim()) {
      throw new Error(
        'Bot handler returned an empty response',
      )
    }

    await sendBotReply(
      params.organizationId,
      params.conversationId,
      reply.text,
    )

    log.info('whatsapp.bot_reply_processed', {
      conversationId: params.conversationId,
      customerId: params.customerId,
    })
  } catch (error) {
    log.error('whatsapp.bot_processing_failed', {
      conversationId: params.conversationId,
      customerId: params.customerId,
      incomingTextLength: text.length,
      error: errorMessage(error),
    })

    // Do not swallow this error.
    // The inbound pipeline must know that bot processing failed.

    throw error
  }
}

// -----------------------------------------------------------------------------
// OUTBOUND MESSAGE ROUTING
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
    return {
      ok: false,
      error: 'Message cannot be empty',
    }
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters`,
    }
  }

  const recipient = normalizePhoneNumber(params.to)
  if (!recipient) {
    return {
      ok: false,
      error: 'A valid recipient phone number is required',
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

  // Never arbitrarily select one of multiple WhatsApp accounts.

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
          id: conversation.id,
        },
        data: {
          whatsappAccountId: accountId,
        },
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
      await emitMessageCreated(
        params.organizationId,
        params.conversationId,
        record.id,
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
            to: recipient,
            text,
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

      await db.conversation.update({
        where: {
          id: params.conversationId,
        },
        data: {
          lastMessageAt: new Date(),
        },
      })

      await emitMessageCreated(
        params.organizationId,
        params.conversationId,
        record.id,
      )

      log.info('whatsapp.baileys_message_sent', {
        accountId,
        conversationId: params.conversationId,
        messageId: result.messageId,
      })

      return {
        ok: true,
        messageId: result.messageId,
      }
    } catch (error) {
      const message = errorMessage(error)

      await db.message.update({
        where: {
          id: record.id,
        },
        data: {
          status: 'FAILED',
        },
      })

      await emitMessageCreated(
        params.organizationId,
        params.conversationId,
        record.id,
      )

      log.error('whatsapp.baileys_send_failed', {
        accountId,
        conversationId: params.conversationId,
        message: errorMessage(error),
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
    await emitMessageCreated(
      params.organizationId,
      params.conversationId,
      record.id,
    )

    return {
      ok: false,
      error: 'WhatsApp not connected',
    }
  }

  try {
    const provider = providerForConnection(conn)

    const result = await provider.sendTextMessage(
      recipient,
      text,
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

    if (result.ok) {
      await db.conversation.update({
        where: {
          id: params.conversationId,
        },
        data: {
          lastMessageAt: new Date(),
        },
      })
    }

    await emitMessageCreated(
      params.organizationId,
      params.conversationId,
      record.id,
    )

    return result
  } catch (error) {
    const message = errorMessage(error)

    await db.message.update({
      where: {
        id: record.id,
      },
      data: {
        status: 'FAILED',
      },
    })

    await emitMessageCreated(
      params.organizationId,
      params.conversationId,
      record.id,
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
  if (!text.trim()) {
    throw new Error('Bot attempted to send an empty reply')
  }

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
    throw new Error(
      `Bot reply failed: conversation ${conversationId} not found`,
    )
  }

  const to = conversation.customer.phoneNumber

  if (!to) {
    throw new Error(
      `Bot reply failed: customer number missing for ${conversationId}`,
    )
  }

  const result = await sendOutbound({
    organizationId,
    conversationId,
    to,
    text,
    senderType: 'BOT',
  })

  if (!result.ok) {
    throw new Error(
      result.error || 'WhatsApp bot reply delivery failed',
    )
  }

  log.info('whatsapp.bot_reply_sent', {
    conversationId,
    messageId: result.messageId,
  })
}

// -----------------------------------------------------------------------------
// DEVELOPMENT ADAPTER
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
      reason: 'Simulation disabled in production mode',
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
