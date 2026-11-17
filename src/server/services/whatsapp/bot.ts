
import { db } from '@/lib/db'
import { createLogger } from '@/server/logger'

const log = createLogger('whatsapp.bot')

/**
 * WhatsApp bot conversation state machine.
 *
 * Supported flows:
 * - Greetings and help
 * - Complaint detection and registration
 * - Complaint location collection
 * - Ticket status lookup
 * - Feedback collection
 *
 * Bot state is persisted in the database so conversations
 * survive restarts and multiple application instances.
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

I can help you with:

1️⃣ Register a complaint — describe your issue.
2️⃣ Check complaint status — send STATUS SS-10001.
3️⃣ Rate a resolution — send RATE SS-10001 5.

How can I help you today?`

const HELP_MESSAGE = `Here are the things I can help you with:

📝 Register a complaint:
Describe your issue, for example:
"The water supply is not working."

🔍 Check complaint status:
STATUS SS-10001

⭐ Rate a resolved complaint:
RATE SS-10001 5

You can send CANCEL anytime to stop an active complaint registration.`

const CANCEL_MESSAGE =
  'Your current complaint registration has been cancelled. You can describe a new issue whenever you need help.'

/**
 * Detect whether a message contains a complaint or service issue.
 *
 * This is intentionally conservative. Ordinary greetings,
 * acknowledgements and unrelated messages must not create tickets.
 */
function isComplaintIntent(text: string): boolean {
  const normalized = text.toLowerCase()

  const patterns = [
    /\bcomplaint\b/,
    /\bproblem\b/,
    /\bissue\b/,
    /\bnot working\b/,
    /\bdoesn't work\b/,
    /\bdoes not work\b/,
    /\bnot functioning\b/,
    /\bbroken\b/,
    /\bdamaged\b/,
    /\bfault\b/,
    /\bfaulty\b/,
    /\brepair\b/,
    /\bmaintenance\b/,
    /\bleak\b/,
    /\bleaking\b/,
    /\bblocked\b/,
    /\bclogged\b/,
    /\bdirty\b/,
    /\bcleaning\b/,
    /\bno water\b/,
    /\bno electricity\b/,
    /\bpower cut\b/,
    /\bpower outage\b/,
    /\bunavailable\b/,
    /\bfailed\b/,
    /\bstopped working\b/,
    /\bunable to\b/,
    /\burgent\b/,
    /\bnot receiving\b/,
    /\bmissing\b/,
    /\bincorrect\b/,
    /\bunsafe\b/,
    /\bsmell\b/,
    /\bnoise\b/,
    /\bdisconnected\b/,
    /\bslow internet\b/,
    /\bwater supply\b/,
    /\belectricity\b/,
  ]

  return patterns.some((pattern) => pattern.test(normalized))
}

/**
 * Detect common greetings.
 */
function isGreeting(text: string): boolean {
  return /^(hi+|hello+|hey+|good morning|good afternoon|good evening|namaste|hlo)[!. ,]*$/i.test(
    text.trim(),
  )
}

/**
 * Detect acknowledgements and polite messages.
 */
function isAcknowledgement(text: string): boolean {
  return /^(thanks|thank you|thank u|thx|ok|okay|alright|got it|cool|great|nice|understood|bye|goodbye|see you)[!. ,]*$/i.test(
    text.trim(),
  )
}

/**
 * Entry point for every inbound customer text message.
 */
export async function handleCustomerMessage(params: {
  organizationId: string
  conversationId: string
  customerId: string
  text: string
  customerName: string | null
}): Promise<BotReply> {
  const {
    organizationId,
    conversationId,
    customerId,
    text,
    customerName,
  } = params

  const trimmed = text.trim()
  const normalized = trimmed.toLowerCase()

  if (!trimmed) {
    return {
      text: 'I received your message. Please send a text message describing how I can help you.',
    }
  }

  // Create or retrieve persistent conversation state.
  const state = await db.botState.upsert({
    where: { conversationId },
    create: {
      organizationId,
      conversationId,
      customerId,
      flow: 'IDLE',
      context: null,
    },
    update: {
      updatedAt: new Date(),
    },
  })

  const context = parseContext(state.context)

  // ---------------------------------------------------------
  // 1. GLOBAL COMMANDS
  // These commands work regardless of the current flow.
  // ---------------------------------------------------------

  if (normalized === 'cancel' || normalized === 'stop') {
    await resetBotFlow(conversationId)

    return {
      text: CANCEL_MESSAGE,
    }
  }

  if (/^(help|menu|options)$/i.test(trimmed)) {
    return {
      text: HELP_MESSAGE,
    }
  }

  // Ticket status lookup.
  const statusMatch =
    trimmed.match(/^status[:\s]+(ss-\d+)$/i) ||
    trimmed.match(/^check(?:\s+status)?[:\s]+(ss-\d+)$/i)

  if (/^status\b/i.test(trimmed) || /^check status\b/i.test(trimmed)) {
    return handleStatusLookup(
      organizationId,
      customerId,
      statusMatch?.[1],
    )
  }

  // Allow customers to check their own ticket by mentioning
  // its ticket number while not in an active collection flow.
  const ticketMatch = trimmed.match(/\b(ss-\d+)\b/i)

  if (
    ticketMatch &&
    state.flow === 'IDLE' &&
    trimmed.length <= 60
  ) {
    return handleStatusLookup(
      organizationId,
      customerId,
      ticketMatch[1],
    )
  }

  // Ticket feedback command.
  const rateMatch = trimmed.match(
    /^rate[:\s]+(ss-\d+)[:\s]+([1-5])$/i,
  )

  if (rateMatch) {
    return handleRating(
      organizationId,
      customerId,
      rateMatch[1],
      Number(rateMatch[2]),
    )
  }

  // ---------------------------------------------------------
  // 2. ACTIVE CONVERSATION FLOWS
  // ---------------------------------------------------------

  if (state.flow === 'COLLECTING_LOCATION') {
    // Don't accidentally treat a greeting as a location.
    if (isGreeting(trimmed)) {
      return {
        text: `We're currently registering your complaint.

Issue: "${context.description || 'Your reported issue'}"

Please share your location so we can continue.

Send CANCEL if you want to stop.`,
      }
    }

    if (trimmed.length < 2) {
      return {
        text: 'Please provide a valid location, such as Block B, Room 302.',
      }
    }

    const description = context.description || trimmed

    return createTicketFromBot({
      organizationId,
      conversationId,
      customerId,
      description,
      location: trimmed,
    })
  }

  if (state.flow === 'FEEDBACK_RATING') {
    const ticket = context.pendingTicket

    const ratingMatch = trimmed.match(/^([1-5])(?:\s*stars?)?$/i)

    if (ticket && ratingMatch) {
      return handleRating(
        organizationId,
        customerId,
        ticket,
        Number(ratingMatch[1]),
      )
    }

    return {
      text: 'Please reply with a rating from 1 to 5.\n\n1 = Poor\n2 = Fair\n3 = Average\n4 = Good\n5 = Excellent',
    }
  }

  // ---------------------------------------------------------
  // 3. GREETINGS
  // ---------------------------------------------------------

  if (isGreeting(trimmed)) {
    return {
      text: `Hello${customerName ? ` ${customerName}` : ''}! 👋

Welcome to SmartServe.

${HELP_MESSAGE}`,
    }
  }

  // ---------------------------------------------------------
  // 4. ACKNOWLEDGEMENTS
  // ---------------------------------------------------------

  if (isAcknowledgement(trimmed)) {
    return {
      text: 'You’re welcome! 😊 Feel free to message us whenever you need assistance.',
    }
  }

  // ---------------------------------------------------------
  // 5. COMPLAINT DETECTION
  // ---------------------------------------------------------

  if (isComplaintIntent(trimmed)) {
    await db.botState.update({
      where: { conversationId },
      data: {
        flow: 'COLLECTING_LOCATION',
        context: JSON.stringify({
          description: trimmed,
        } satisfies BotContext),
      },
    })

    return {
      text: `I'm sorry you're experiencing this issue. I'll help you register a complaint. 📝

Issue: "${trimmed}"

Please share your location so our team can assist you.

For example:
Block B, Room 302

Send CANCEL if you don't want to continue.`,
    }
  }

  // ---------------------------------------------------------
  // 6. GENERAL MESSAGE
  // ---------------------------------------------------------

  // An ordinary message must never create a complaint automatically.
  return {
    text: `Thanks for contacting SmartServe! 😊

I'm your automated support assistant.

I can help you with:

📝 Register a complaint
🔍 Check an existing ticket
⭐ Submit feedback

To register a complaint, describe the problem you're facing.

To check a ticket, send:
STATUS SS-10001

Send HELP to see all available options.`,
  }
}

/**
 * Create a complaint after collecting its description and location.
 */
async function createTicketFromBot(params: {
  organizationId: string
  conversationId: string
  customerId: string
  description: string
  location: string
}): Promise<BotReply> {
  const {
    organizationId,
    conversationId,
    customerId,
    description,
    location,
  } = params

  try {
    const { complaintService } = await import(
      '@/server/services/complaint-service'
    )

    const complaint = await complaintService.createComplaintFromBot({
      organizationId,
      conversationId,
      customerId,
      description: `${description}\n\nLocation: ${location}`,
      locationName: location,
    })

    await db.botState.updateMany({
      where: { conversationId },
      data: {
        flow: 'IDLE',
        context: JSON.stringify({
          pendingTicket: complaint.ticketNumber,
        } satisfies BotContext),
      },
    })

    const priorityLabel =
      complaint.priority.charAt(0) +
      complaint.priority.slice(1).toLowerCase()

    return {
      text: `Thank you! Your complaint has been successfully registered. ✅

🎫 Ticket: ${complaint.ticketNumber}
📂 Category: ${complaint.category?.name || 'General'}
🚨 Priority: ${priorityLabel}
📍 Location: ${location}

You can check the status anytime by sending:

STATUS ${complaint.ticketNumber}

Thank you for contacting SmartServe.`,
    }
  } catch (error) {
    log.error({ error, conversationId }, 'Failed to create complaint from WhatsApp bot')

    // Reset the flow so the customer is not stuck.
    await resetBotFlow(conversationId)

    return {
      text: `Sorry, we couldn't register your complaint right now.

Your information may not have been saved. Please try again in a moment or contact the support team.

We apologize for the inconvenience.`,
    }
  }
}

/**
 * Identity-checked status lookup.
 * Customers can only see their own tickets.
 */
async function handleStatusLookup(
  organizationId: string,
  customerId: string,
  ticketNumber?: string,
): Promise<BotReply> {
  const where = ticketNumber
    ? {
        organizationId,
        customerId,
        ticketNumber: ticketNumber.toUpperCase(),
      }
    : {
        organizationId,
        customerId,
      }

  const complaints = await db.complaint.findMany({
    where,
    orderBy: {
      createdAt: 'desc',
    },
    take: ticketNumber ? 1 : 3,
    select: {
      ticketNumber: true,
      title: true,
      status: true,
      priority: true,
      resolvedAt: true,
      slaDueAt: true,
      createdAt: true,
      assignee: {
        select: {
          name: true,
        },
      },
    },
  })

  if (complaints.length === 0) {
    return {
      text: ticketNumber
        ? `I couldn't find ticket ${ticketNumber.toUpperCase()} associated with your WhatsApp number.

Please check the ticket number and try again.`
        : `You don't have any registered complaints yet.

If you're facing an issue, describe it and I'll help you register a complaint.`,
    }
  }

  const lines = complaints.map((complaint) => {
    const statusLabel = complaint.status
      .replace(/_/g, ' ')
      .toLowerCase()

    const priorityLabel = complaint.priority
      .replace(/_/g, ' ')
      .toLowerCase()

    return `🎫 Ticket: ${complaint.ticketNumber}
📝 Issue: ${complaint.title}
📌 Status: ${statusLabel}
🚨 Priority: ${priorityLabel}${
      complaint.assignee?.name
        ? `\n👤 Handled by: ${complaint.assignee.name}`
        : ''
    }`
  })

  return {
    text: `Here is your complaint status:

${lines.join('\n\n')}

Need more help? Just send a message.`,
  }
}

/**
 * Submit customer feedback for a ticket.
 */
async function handleRating(
  organizationId: string,
  customerId: string,
  ticketNumber: string,
  rating: number,
): Promise<BotReply> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return {
      text: 'Please provide a valid rating between 1 and 5.',
    }
  }

  try {
    const { feedbackService } = await import(
      '@/server/services/feedback-service'
    )

    const result = await feedbackService.submitFeedback({
      organizationId,
      customerId,
      ticketNumber: ticketNumber.toUpperCase(),
      rating,
    })

    if (!result.ok) {
      return {
        text: result.message,
      }
    }

    await db.botState.updateMany({
      where: {
        customerId,
        organizationId,
      },
      data: {
        flow: 'IDLE',
        context: null,
      },
    })

    return {
      text: `Thank you for rating ticket ${ticketNumber.toUpperCase()} ${rating}/5! ⭐

Your feedback helps us improve our service.`,
    }
  } catch (error) {
    log.error({ error, ticketNumber }, 'Failed to submit WhatsApp feedback')

    return {
      text: 'Sorry, we could not save your feedback right now. Please try again later.',
    }
  }
}

/**
 * Message sent after a complaint is resolved.
 */
export async function sendFeedbackRequestText(
  ticketNumber: string,
): Promise<string> {
  return `Your ticket ${ticketNumber} has been resolved. 🎉

We would love to know how we did.

Please rate the resolution by replying:

RATE ${ticketNumber} 5

You can give any rating from 1 to 5.

1 = Poor
2 = Fair
3 = Average
4 = Good
5 = Excellent

Thank you for your feedback!`
}

/**
 * Reset the bot's active flow for a conversation.
 */
export async function resetBotFlow(
  conversationId: string,
): Promise<void> {
  await db.botState.updateMany({
    where: {
      conversationId,
    },
    data: {
      flow: 'IDLE',
      context: null,
    },
  })
}

export const BOT_MESSAGES = {
  GREETING,
  HELP_MESSAGE,
  CANCEL_MESSAGE,
}

void log
