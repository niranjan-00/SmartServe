import { db } from '@/lib/db'
import { createLogger } from '@/server/logger'

const log = createLogger('whatsapp.bot')

/**
 * WhatsApp bot conversation state machine (spec §27-28).
 * State is persisted in BotState (database) — never in-memory only — so
 * conversations survive restarts and multi-instance deployments.
 *
 * Flows:
 *   - Complaint collection: description → location → confirm → ticket
 *   - STATUS <ticket> / natural-language lookup (identity-checked)
 *   - Feedback collection after resolution
 */

export interface BotReply {
  text: string
}

interface BotContext {
  description?: string
  pendingTicket?: string
}

function parseContext(raw: string | null): BotContext {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as BotContext
  } catch {
    return {}
  }
}

const GREETING = `Hello! 👋 I'm the SmartServe assistant.
I can help you:
1. Register a complaint — just describe the issue
2. Check status — send STATUS <ticket> (e.g. STATUS SS-10001)
3. Rate a resolution — send RATE <ticket> <1-5> (e.g. RATE SS-10001 5)`

/** Entry point for every inbound customer text message. */
export async function handleCustomerMessage(params: {
  organizationId: string
  conversationId: string
  customerId: string
  text: string
  customerName: string | null
}): Promise<BotReply> {
  const { organizationId, conversationId, customerId, text } = params
  const trimmed = text.trim()

  const state = await db.botState.upsert({
    where: { conversationId },
    create: { organizationId, conversationId, customerId, flow: 'IDLE', context: null },
    update: { updatedAt: new Date() },
  })

  const ctx = parseContext(state.context)

  // --- Global commands -----------------------------------------------------
  const statusMatch = trimmed.match(/^status[:\s]+(ss-\d+)$/i) || trimmed.match(/\b(ss-\d+)\b/i)
  if (/^status\b/i.test(trimmed) || (statusMatch && state.flow === 'IDLE' && trimmed.length <= 40)) {
    return handleStatusLookup(organizationId, customerId, statusMatch?.[1])
  }

  const rateMatch = trimmed.match(/^rate[:\s]+(ss-\d+)[:\s]+([1-5])$/i)
  if (rateMatch) {
    return handleRating(organizationId, customerId, rateMatch[1], Number(rateMatch[2]))
  }

  // --- Active flows --------------------------------------------------------
  switch (state.flow) {
    case 'COLLECTING_LOCATION': {
      const description = ctx.description || trimmed
      return createTicketFromBot({ organizationId, conversationId, customerId, description, location: trimmed })
    }
    case 'FEEDBACK_RATING': {
      const ticket = (parseContext(state.context) as BotContext).pendingTicket
      const n = Number(trimmed.match(/[1-5]/)?.[0])
      if (ticket && n >= 1 && n <= 5) return handleRating(organizationId, customerId, ticket, n)
      return { text: 'Please reply with a rating from 1 to 5 (1 = poor, 5 = excellent).' }
    }
    default:
      break
  }

  // --- Default: start complaint collection ---------------------------------
  await db.botState.update({
    where: { conversationId },
    data: { flow: 'COLLECTING_LOCATION', context: JSON.stringify({ description: trimmed } satisfies BotContext) },
  })
  const first = !state.updatedAt || state.flow === 'IDLE'
  return {
    text: first
      ? `I'll help you register a complaint.\nI understood: "${trimmed}"\n\nWhat is your location? (e.g. Block B Room 302)`
      : `Got it — let's update your complaint.\nI understood: "${trimmed}"\n\nWhat is your location?`,
  }
}

async function createTicketFromBot(params: {
  organizationId: string
  conversationId: string
  customerId: string
  description: string
  location: string
}): Promise<BotReply> {
  const { complaintService } = await import('@/server/services/complaint-service')
  const complaint = await complaintService.createComplaintFromBot({
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    customerId: params.customerId,
    description: `${params.description}\n\nLocation: ${params.location}`,
    locationName: params.location,
  })

  await db.botState.updateMany({
    where: { conversationId: params.conversationId },
    data: { flow: 'IDLE', context: JSON.stringify({ pendingTicket: complaint.ticketNumber }) },
  })

  const priorityLabel = complaint.priority.charAt(0) + complaint.priority.slice(1).toLowerCase()
  return {
    text: `Thank you. Your complaint has been registered.\n\nTicket: ${complaint.ticketNumber}\nCategory: ${complaint.category?.name || 'General'}\nPriority: ${priorityLabel}\n\nYou can check status anytime by sending: STATUS ${complaint.ticketNumber}`,
  }
}

/** Identity-checked status lookup — customers only see their own tickets (spec §28). */
async function handleStatusLookup(organizationId: string, customerId: string, ticketNumber?: string): Promise<BotReply> {
  const where = ticketNumber
    ? { organizationId, customerId, ticketNumber: ticketNumber.toUpperCase() }
    : { organizationId, customerId }

  const complaints = await db.complaint.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: ticketNumber ? 1 : 3,
    select: {
      ticketNumber: true,
      title: true,
      status: true,
      priority: true,
      resolvedAt: true,
      slaDueAt: true,
      createdAt: true,
      assignee: { select: { name: true } },
    },
  })

  if (complaints.length === 0) {
    return {
      text: ticketNumber
        ? `I couldn't find ticket ${ticketNumber.toUpperCase()} associated with your WhatsApp number. Please check the ticket number and try again.`
        : "You don't have any registered complaints yet. Describe an issue and I'll register it for you.",
    }
  }

  const lines = complaints.map((c) => {
    const statusLabel = c.status.replace('_', ' ').toLowerCase()
    return `Ticket: ${c.ticketNumber}\nIssue: ${c.title}\nStatus: ${statusLabel}${c.assignee?.name ? `\nHandled by: ${c.assignee.name}` : ''}`
  })
  return { text: lines.join('\n\n') }
}

async function handleRating(organizationId: string, customerId: string, ticketNumber: string, rating: number): Promise<BotReply> {
  const { feedbackService } = await import('@/server/services/feedback-service')
  const result = await feedbackService.submitFeedback({
    organizationId,
    customerId,
    ticketNumber: ticketNumber.toUpperCase(),
    rating,
  })
  if (!result.ok) return { text: result.message }
  return { text: `Thank you for rating ticket ${ticketNumber.toUpperCase()} ${rating}/5! Your feedback helps us improve.` }
}

/** Sent after a complaint is resolved — invites the customer to rate (spec §37). */
export async function sendFeedbackRequestText(ticketNumber: string): Promise<string> {
  void db
  return `Your ticket ${ticketNumber} has been resolved. 🎉\nHow would you rate the resolution? Reply with:\nRATE ${ticketNumber} <1-5>\n(1 = poor, 5 = excellent)`
}

export function resetBotFlow(conversationId: string): Promise<void> {
  return db.botState.updateMany({ where: { conversationId }, data: { flow: 'IDLE', context: null } }).then(() => undefined)
}

export const BOT_MESSAGES = { GREETING }
void log
