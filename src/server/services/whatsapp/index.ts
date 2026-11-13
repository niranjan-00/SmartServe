
import { db } from '@/lib/db'
import { emitToOrganization } from '@/server/realtime'
import { handleCustomerMessage } from './bot'
import { callBaileysWorker } from './baileys-client'

/**
 * WhatsAppService — the integration point between SmartServe
 * and the configured WhatsApp provider.
 */

/** Processes an inbound event received from the dedicated Baileys worker. */
export async function processBaileysInbound(input: {
  accountId: string
  from: string
  profileName?: string | null
  whatsappMessageId: string
  timestamp: string
  messageType?: string
  text?: string
}) {
  const account = await db.whatsAppAccount.findUnique({ where: { id: input.accountId } })
  if (!account) throw new Error('Unknown WhatsApp account')
  if (!input.whatsappMessageId || !input.from) throw new Error('Invalid inbound message')

  try {
    await db.webhookEvent.create({
      data: {
        provider: 'BAILEYS',
        eventId: input.whatsappMessageId,
        eventType: 'message',
        processed: false,
      },
    })
  } catch {
    const previous = await db.webhookEvent.findUnique({ where: { eventId: input.whatsappMessageId }, select: { processed: true } })
    if (previous?.processed) return { accepted: true, duplicate: true }
    // A prior attempt failed after the idempotency row was written; retry processing it.
  }

  const timestamp = new Date(input.timestamp)
  const safeTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp
  const text = input.text?.trim() || (input.messageType && input.messageType !== 'TEXT' ? `[${input.messageType.toLowerCase()} attachment received]` : '')

  try {
    const { conversation, message, customer } = await db.$transaction(async (tx) => {
      const customer = await tx.customer.upsert({
        where: { organizationId_phoneNumber: { organizationId: account.organizationId, phoneNumber: input.from } },
        create: {
          organizationId: account.organizationId,
          phoneNumber: input.from,
          whatsappId: input.from,
          name: input.profileName || null,
        },
        update: input.profileName ? { name: input.profileName } : {},
      })
      const existing = await tx.conversation.findFirst({
        where: { organizationId: account.organizationId, customerId: customer.id, whatsappAccountId: account.id, status: 'OPEN' },
        orderBy: { lastMessageAt: 'desc' },
      })
      const conversation = existing
        ? await tx.conversation.update({ where: { id: existing.id }, data: { lastMessageAt: safeTimestamp } })
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
          messageType: input.messageType || 'TEXT',
          content: text,
          direction: 'INBOUND',
          status: 'RECEIVED',
          createdAt: safeTimestamp,
        },
      })
      return { conversation, message, customer }
    })

    await db.webhookEvent.update({ where: { eventId: input.whatsappMessageId }, data: { processed: true, processedAt: new Date() } })
    await emitToOrganization(account.organizationId, 'message.created', { conversationId: conversation.id, messageId: message.id })

    if (text) {
      const reply = await handleCustomerMessage({
        organizationId: account.organizationId,
        conversationId: conversation.id,
        customerId: customer.id,
        text,
        customerName: customer.name,
      })
      await sendBotReply(account.organizationId, conversation.id, reply.text)
    }
    return { accepted: true, duplicate: false, conversationId: conversation.id, messageId: message.id }
  } catch (error) {
    await db.webhookEvent.updateMany({
      where: { eventId: input.whatsappMessageId },
      data: { error: error instanceof Error ? error.message.slice(0, 500) : 'Inbound processing failed' },
    })
    throw error
  }
}

/** Persists and sends an outbound message through the selected provider. */
export async function sendOutbound(params: {
  organizationId: string
  conversationId: string
  to: string
  text: string
  senderType?: 'BOT' | 'STAFF' | 'SYSTEM'
  senderId?: string
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const conversation = await db.conversation.findFirst({
    where: { id: params.conversationId, organizationId: params.organizationId },
    select: { whatsappAccountId: true },
  })
  let accountId = conversation?.whatsappAccountId
  if (!accountId) {
    // Backward-compatible routing for pre-migration conversations only when
    // the organization has exactly one connected number; never guess among many.
    const available = await db.whatsAppAccount.findMany({
      where: { organizationId: params.organizationId, status: 'CONNECTED' },
      select: { id: true },
      take: 2,
    })
    if (available.length === 1) {
      accountId = available[0].id
      await db.conversation.update({ where: { id: params.conversationId }, data: { whatsappAccountId: accountId } })
    }
  }
  const account = accountId
    ? await db.whatsAppAccount.findFirst({ where: { id: accountId, organizationId: params.organizationId } })
    : null

  const record = await db.message.create({
    data: {
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      senderType: params.senderType ?? 'SYSTEM',
      senderId: params.senderId,
      messageType: 'TEXT',
      content: params.text,
      direction: 'OUTBOUND',
      status: account?.status === 'CONNECTED' ? 'SENT' : 'FAILED',
    },
  })

  if (!account || account.status !== 'CONNECTED') {
    return { ok: false, error: 'The WhatsApp number assigned to this conversation is not connected' }
  }

  try {
    const result = await callBaileysWorker(`/sessions/${encodeURIComponent(account.id)}/send`, {
      method: 'POST',
      body: JSON.stringify({ to: params.to, text: params.text }),
    })
    await db.message.update({ where: { id: record.id }, data: { status: 'SENT', whatsappMessageId: result.messageId ?? null } })
    await emitToOrganization(params.organizationId, 'message.created', { conversationId: params.conversationId, messageId: record.id })
    return { ok: true, messageId: result.messageId }
  } catch (error) {
    await db.message.update({ where: { id: record.id }, data: { status: 'FAILED' } })
    return { ok: false, error: error instanceof Error ? error.message : 'Baileys could not send the message' }
  }
}

async function sendBotReply(
  organizationId: string,
  conversationId: string,
  text: string,
): Promise<void> {
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
