
import { db } from '@/lib/db'
import { createLogger } from '@/server/logger'

const log = createLogger('whatsapp.bot')

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export interface BotReply {
  text: string
}

interface BotContext {
  description?: string
  pendingTicket?: string
}

type BotFlow =
  | 'IDLE'
  | 'COLLECTING_LOCATION'
  | 'FEEDBACK_RATING'

interface CustomerMessageParams {
  organizationId: string
  conversationId: string
  customerId: string
  customerName: string | null
  text: string
  /** WhatsApp provider message ID for inbound retry/idempotency recovery. */
  whatsappMessageId?: string | null
}

// -----------------------------------------------------------------------------
// MESSAGE CONTENT
// -----------------------------------------------------------------------------

const GREETING = `Hello! Welcome to SmartServe.

How may we help you today?

I can assist you with:
📝 Registering a complaint
🔍 Checking an existing complaint
⭐ Submitting feedback

Please tell me what you need assistance with.`

const HELP_MESSAGE = `Welcome to SmartServe Support.

Here are the services I can help you with:

📝 REGISTER A COMPLAINT
Describe the issue you are experiencing.

Example:
"The water supply is not working."

🔍 CHECK COMPLAINT STATUS
Send:
STATUS SS-10001

⭐ RATE A RESOLVED COMPLAINT
Send:
RATE SS-10001 5

❌ CANCEL
Send CANCEL to stop an ongoing complaint registration.

You can also send a photo or voice note to explain your issue.`

const CANCEL_MESSAGE =
  'Your current complaint registration has been cancelled.\n\nYou can contact us again whenever you need assistance.'

const LOCATION_PROMPT = `Thank you for reporting this issue.

To register your complaint, please share the location where the problem is occurring.

For example:
• Building A, Room 102
• Block B, Floor 2
• Main office, Reception

Please provide the location to continue.

Send CANCEL if you do not want to proceed.`

const GENERAL_MESSAGE = `Thank you for contacting SmartServe.

I am your automated support assistant. I can help you with:

📝 Registering a complaint
🔍 Checking complaint status
⭐ Providing feedback

To register a complaint, describe the issue you are experiencing.

To check an existing complaint, send:
STATUS SS-10001

Send HELP to view all available options.`

// -----------------------------------------------------------------------------
// CONTEXT HELPERS
// -----------------------------------------------------------------------------

function parseContext(raw: string | null): BotContext {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    return {
      description:
        typeof parsed.description === 'string'
          ? parsed.description
          : undefined,
      pendingTicket:
        typeof parsed.pendingTicket === 'string'
          ? parsed.pendingTicket
          : undefined,
    }
  } catch {
    return {}
  }
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function formatName(name: string | null): string {
  if (!name?.trim()) return ''

  return name
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

// -----------------------------------------------------------------------------
// INTENT DETECTION
// -----------------------------------------------------------------------------

/**
 * Detects greetings without treating a sentence containing a greeting
 * as a greeting-only message.
 */
function isGreeting(text: string): boolean {
  const normalized = normalizeText(text)

  return /^(hi+|hello+|hey+|hlo+|namaste|good morning|good afternoon|good evening|good day)[!.,\s]*$/i.test(
    normalized,
  )
}

/**
 * Detect acknowledgements and polite messages.
 */
function isAcknowledgement(text: string): boolean {
  const normalized = normalizeText(text)

  return /^(thanks|thank you|thank u|thx|ok|okay|alright|got it|cool|great|nice|understood|bye|goodbye|see you|fine|sure|no problem)[!.,\s]*$/i.test(
    normalized,
  )
}

/**
 * Detect explicit complaint or service-problem intent.
 *
 * This is deliberately based on issue-related phrases rather than
 * generic words such as "help", "water" or "electricity" alone.
 */
function isComplaintIntent(text: string): boolean {
  const normalized = normalizeText(text)

  const patterns = [
    // Explicit complaint language
    /\bcomplaint\b/,
    /\bcomplain\b/,
    /\bi want to report\b/,
    /\bi need to report\b/,
    /\bi would like to report\b/,
    /\bi want to raise\b/,
    /\bi need to raise\b/,
    /\braise a ticket\b/,
    /\bregister a complaint\b/,
    /\bfile a complaint\b/,

    // General problem descriptions
    /\bproblem with\b/,
    /\bissue with\b/,
    /\bfacing a problem\b/,
    /\bfacing an issue\b/,
    /\bthere is a problem\b/,
    /\bthere is an issue\b/,
    /\bexperiencing a problem\b/,
    /\bexperiencing an issue\b/,
    /\bsomething is wrong\b/,
    /\bnot working\b/,
    /\bdoes not work\b/,
    /\bdoesn't work\b/,
    /\bisn't working\b/,
    /\bare not working\b/,
    /\bnot functioning\b/,
    /\bstopped working\b/,
    /\bhas stopped\b/,
    /\bfailed to work\b/,
    /\bnot functioning properly\b/,

    // Physical damage and maintenance
    /\bbroken\b/,
    /\bdamaged\b/,
    /\bfaulty\b/,
    /\bmalfunction\b/,
    /\bmalfunctioning\b/,
    /\bneeds repair\b/,
    /\brepair required\b/,
    /\brepair needed\b/,
    /\bmaintenance required\b/,
    /\bmaintenance needed\b/,
    /\bneeds maintenance\b/,
    /\bneeds fixing\b/,
    /\bneeds to be fixed\b/,

    // Water and plumbing
    /\bno water\b/,
    /\bwater supply (?:is )?(?:not available|unavailable|stopped|interrupted)\b/,
    /\bwater (?:is )?not coming\b/,
    /\bwater leakage\b/,
    /\bwater leak\b/,
    /\bleaking\b/,
    /\bpipe burst\b/,
    /\bblocked drain\b/,
    /\bdrainage problem\b/,
    /\bdrainage issue\b/,
    /\bclogged\b/,
    /\bblocked pipe\b/,

    // Electricity
    /\bno electricity\b/,
    /\bno power\b/,
    /\bpower cut\b/,
    /\bpower outage\b/,
    /\belectricity (?:is )?(?:not available|unavailable|not working)\b/,
    /\bpower supply problem\b/,
    /\bpower supply issue\b/,
    /\bshort circuit\b/,
    /\belectrical fault\b/,
    /\belectrical problem\b/,
    /\belectrical issue\b/,

    // Internet and connectivity
    /\bslow internet\b/,
    /\binternet (?:is )?not working\b/,
    /\bwi[- ]?fi (?:is )?not working\b/,
    /\bnetwork problem\b/,
    /\bnetwork issue\b/,
    /\bno internet\b/,
    /\bdisconnected\b/,
    /\bconnection failed\b/,

    // Cleanliness and facilities
    /\bnot clean\b/,
    /\bdirty\b/,
    /\bcleaning required\b/,
    /\bcleaning needed\b/,
    /\bgarbage not collected\b/,
    /\bwaste not collected\b/,
    /\bbad smell\b/,
    /\bunpleasant smell\b/,
    /\bpest problem\b/,
    /\bpest control\b/,

    // Safety and urgency
    /\bunsafe\b/,
    /\bsafety issue\b/,
    /\bsafety concern\b/,
    /\bemergency\b/,
    /\burgent complaint\b/,
    /\burgent issue\b/,
    /\burgent problem\b/,
    /\bimmediate attention\b/,

    // General service failures
    /\bservice unavailable\b/,
    /\bservice failure\b/,
    /\bservice is delayed\b/,
    /\bnot receiving\b/,
    /\bmissing\b/,
    /\bincorrect\b/,
    /\bunable to use\b/,
    /\bunable to access\b/,
    /\bnot accessible\b/,
    /\bnoise problem\b/,
    /\bexcessive noise\b/,
    /\bcomplaint regarding\b/,
  ]

  return patterns.some((pattern) => pattern.test(normalized))
}

/**
 * Detect a customer asking to update the issue while the bot
 * is waiting for a location.
 */
function isIssueUpdate(text: string): boolean {
  const normalized = normalizeText(text)

  return (
    isComplaintIntent(text) ||
    /\bthe same issue\b/.test(normalized) ||
    /\bone more issue\b/.test(normalized) ||
    /\banother issue\b/.test(normalized) ||
    /\bi also have\b/.test(normalized) ||
    /\balso not working\b/.test(normalized)
  )
}

// -----------------------------------------------------------------------------
// DATABASE STATE
// -----------------------------------------------------------------------------

async function getOrCreateBotState(params: {
  organizationId: string
  conversationId: string
  customerId: string
}) {
  return db.botState.upsert({
    where: {
      conversationId: params.conversationId,
    },
    create: {
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      customerId: params.customerId,
      flow: 'IDLE',
      context: null,
    },
    update: {
      updatedAt: new Date(),
    },
  })
}

async function updateBotState(
  conversationId: string,
  flow: BotFlow,
  context: BotContext | null,
): Promise<void> {
  await db.botState.updateMany({
    where: { conversationId },
    data: {
      flow,
      context: context ? JSON.stringify(context) : null,
    },
  })
}

// -----------------------------------------------------------------------------
// MAIN MESSAGE HANDLER
// -----------------------------------------------------------------------------

export async function handleCustomerMessage(
  params: CustomerMessageParams,
): Promise<BotReply> {
  const {
    organizationId,
    conversationId,
    customerId,
    customerName,
  } = params

  const rawText = typeof params.text === 'string' ? params.text : ''
  const trimmed = rawText.trim()
  const normalized = normalizeText(trimmed)

  if (!trimmed) {
    return {
      text: 'We received your message. Please send a description of how we can assist you.',
    }
  }

  if (trimmed.length > 4000) {
    return {
      text: 'Your message is too long. Please send a shorter description (maximum 4,000 characters).',
    }
  }

  try {
    const state = await getOrCreateBotState({
      organizationId,
      conversationId,
      customerId,
    })

    // A conversation state must never be reused across tenants/customers.
    // The upsert key is conversationId, so verify ownership before reading it.
    if (
      state.organizationId !== organizationId ||
      state.customerId !== customerId
    ) {
      throw new Error('WhatsApp bot state ownership mismatch')
    }

    const context = parseContext(state.context)
    const flow = state.flow as BotFlow
    const whatsappMessageId = params.whatsappMessageId?.trim() || null

    // If this exact WhatsApp message already created a ticket, return that
    // ticket again. This covers the case where ticket creation succeeded but
    // sending the bot confirmation failed and the provider retried the event.
    if (whatsappMessageId) {
      const previouslyCreated = await db.complaint.findFirst({
        where: {
          organizationId,
          customerId,
          sourceMessageId: whatsappMessageId,
        },
        select: {
          ticketNumber: true,
          title: true,
          priority: true,
          category: { select: { name: true } },
          location: { select: { name: true } },
        },
      })

      if (previouslyCreated) {
        await updateBotState(conversationId, 'IDLE', {
          pendingTicket: previouslyCreated.ticketNumber,
        })

        const priorityLabel =
          previouslyCreated.priority.charAt(0) +
          previouslyCreated.priority.slice(1).toLowerCase()

        return {
          text: `Your complaint has already been registered.

🎫 Ticket Number: ${previouslyCreated.ticketNumber}
📝 Issue: ${previouslyCreated.title}
📂 Category: ${previouslyCreated.category?.name || 'General'}
🚨 Priority: ${priorityLabel}
📍 Location: ${previouslyCreated.location?.name || 'As provided'}

You can check the complaint status at any time by sending:

STATUS ${previouslyCreated.ticketNumber}

Thank you for contacting SmartServe.`,
        }
      }
    }

    // -------------------------------------------------------------------------
    // 1. GLOBAL COMMANDS
    // -------------------------------------------------------------------------

    if (/^(cancel|stop|abort)$/i.test(normalized)) {
      await resetBotFlow(conversationId)

      return {
        text: CANCEL_MESSAGE,
      }
    }

    if (/^(help|menu|options)$/i.test(normalized)) {
      return {
        text: HELP_MESSAGE,
      }
    }

    // -------------------------------------------------------------------------
    // 2. STATUS LOOKUP
    // -------------------------------------------------------------------------

    const statusMatch =
      trimmed.match(/^status(?:\s*:\s*|\s+)(ss-\d+)$/i) ||
      trimmed.match(/^check\s+(?:status\s+)?(ss-\d+)$/i) ||
      trimmed.match(/^track\s+(ss-\d+)$/i)

    if (
      /^status\b/i.test(trimmed) ||
      /^check\s+status\b/i.test(trimmed) ||
      /^track\b/i.test(trimmed)
    ) {
      if (!statusMatch?.[1]) {
        return {
          text: `Please provide your ticket number to check its status.

Example:
STATUS SS-10001`,
        }
      }

      return handleStatusLookup(
        organizationId,
        customerId,
        statusMatch[1],
      )
    }

    // -------------------------------------------------------------------------
    // 3. FEEDBACK COMMAND
    // -------------------------------------------------------------------------

    const rateMatch = trimmed.match(
      /^rate\s*:?\s*(ss-\d+)\s+([1-5])$/i,
    )

    if (rateMatch) {
      return handleRating(
        organizationId,
        customerId,
        rateMatch[1],
        Number(rateMatch[2]),
        conversationId,
      )
    }

    // -------------------------------------------------------------------------
    // 4. DIRECT TICKET NUMBER LOOKUP
    // -------------------------------------------------------------------------

    const ticketMatch = trimmed.match(/\b(ss-\d+)\b/i)

    if (
      ticketMatch &&
      flow === 'IDLE' &&
      trimmed.length <= 80
    ) {
      return handleStatusLookup(
        organizationId,
        customerId,
        ticketMatch[1],
      )
    }

    // -------------------------------------------------------------------------
    // 5. ACTIVE LOCATION COLLECTION
    // -------------------------------------------------------------------------

    if (flow === 'COLLECTING_LOCATION') {
      // The customer is greeting us while a complaint is pending.
      if (isGreeting(trimmed)) {
        return {
          text: `Hello! Your complaint registration is still in progress.

Issue: ${context.description || 'Your reported issue'}

Please share the location where the issue is occurring so we can continue.

Send CANCEL if you want to stop.`,
        }
      }

      // The customer may change or add to the issue description.
      // Do not mistakenly treat a new complaint as a location.
      if (isIssueUpdate(trimmed)) {
        await updateBotState(
          conversationId,
          'COLLECTING_LOCATION',
          {
            description: trimmed,
          },
        )

        return {
          text: `Thank you for the additional information.

I have updated your issue description:

"${trimmed}"

Please share the location where this issue is occurring so we can register your complaint.`,
        }
      }

      if (isAcknowledgement(trimmed)) {
        return {
          text: `Thank you.

Your complaint registration is waiting for the location.

Please share the building, block, room or area where the issue is occurring.`,
        }
      }

      if (trimmed.length < 2 || trimmed.length > 250) {
        return {
          text: 'Please provide a valid location between 2 and 250 characters.',
        }
      }

      // The customer has provided a location.
      // Create the ticket only at this point.
      return createTicketFromBot({
        organizationId,
        conversationId,
        customerId,
        description: context.description || 'Customer-reported issue',
        location: trimmed,
        sourceMessageId: whatsappMessageId,
      })
    }

    // -------------------------------------------------------------------------
    // 6. ACTIVE FEEDBACK COLLECTION
    // -------------------------------------------------------------------------

    if (flow === 'FEEDBACK_RATING') {
      const ticket = context.pendingTicket
      const ratingMatch = trimmed.match(/^([1-5])(?:\s*stars?)?$/i)

      if (ticket && ratingMatch) {
        return handleRating(
          organizationId,
          customerId,
          ticket,
          Number(ratingMatch[1]),
          conversationId,
        )
      }

      return {
        text: `Please provide a rating from 1 to 5.

1 = Poor
2 = Fair
3 = Average
4 = Good
5 = Excellent`,
      }
    }

    // -------------------------------------------------------------------------
    // 7. GREETINGS
    // -------------------------------------------------------------------------

    if (isGreeting(trimmed)) {
      const name = formatName(customerName)

      return {
        text: `Hello${name ? ` ${name}` : ''}! Welcome to SmartServe.

How may we help you today?

I can assist you with:
📝 Registering a complaint
🔍 Checking an existing complaint
⭐ Submitting feedback

Please describe your issue if you need to register a complaint.`,
      }
    }

    // -------------------------------------------------------------------------
    // 8. ACKNOWLEDGEMENTS
    // -------------------------------------------------------------------------

    if (isAcknowledgement(trimmed)) {
      return {
        text: 'Thank you for contacting SmartServe. Please let us know whenever you need assistance. We will be happy to help.',
      }
    }

    // -------------------------------------------------------------------------
    // 9. COMPLAINT DETECTION
    // -------------------------------------------------------------------------

    if (isComplaintIntent(trimmed)) {
      await updateBotState(
        conversationId,
        'COLLECTING_LOCATION',
        {
          description: trimmed,
        },
      )

      return {
        text: `Thank you for informing us.

We understand that you are experiencing the following issue:

"${trimmed}"

We will help you register a complaint.

${LOCATION_PROMPT}`,
      }
    }

    // -------------------------------------------------------------------------
    // 10. GENERAL QUERIES
    // -------------------------------------------------------------------------

    // General messages must not automatically create complaints.
    return {
      text: GENERAL_MESSAGE,
    }
  } catch (error) {
    log.error(
      {
        error,
        organizationId,
        conversationId,
        customerId,
      },
      'WhatsApp bot message processing failed',
    )

    // Let the inbound processor know this message was not completed.
    // Returning a friendly string here would make the caller mark it successful.
    throw error
  }
}

// -----------------------------------------------------------------------------
// COMPLAINT REGISTRATION
// -----------------------------------------------------------------------------

async function createTicketFromBot(params: {
  organizationId: string
  conversationId: string
  customerId: string
  description: string
  location: string
  sourceMessageId: string | null
}): Promise<BotReply> {
  const {
    organizationId,
    conversationId,
    customerId,
    description,
    location,
    sourceMessageId,
  } = params

  try {
    const { complaintService } = await import(
      '@/server/services/complaint-service'
    )

    const complaint =
      await complaintService.createComplaintFromBot({
        organizationId,
        conversationId,
        customerId,
        description: `${description}\n\nLocation: ${location}`,
        locationName: location,
        sourceMessageId,
      })

    await updateBotState(
      conversationId,
      'IDLE',
      {
        pendingTicket: complaint.ticketNumber,
      },
    )

    const priorityLabel =
      complaint.priority.charAt(0) +
      complaint.priority.slice(1).toLowerCase()

    return {
      text: `Your complaint has been successfully registered.

Thank you for reporting the issue.

🎫 Ticket Number: ${complaint.ticketNumber}
📂 Category: ${complaint.category?.name || 'General'}
🚨 Priority: ${priorityLabel}
📍 Location: ${location}

You can check the complaint status at any time by sending:

STATUS ${complaint.ticketNumber}

Thank you for contacting SmartServe. Our team will review your complaint.`,
    }
  } catch (error) {
    log.error(
      {
        error,
        conversationId,
        customerId,
      },
      'Failed to create complaint from WhatsApp bot',
    )

    // Preserve the description and location so a retry can continue the flow.
    // The caller must treat this as failed processing and retry safely.
    await updateBotState(conversationId, 'COLLECTING_LOCATION', {
      description,
    })

    throw error
  }
}

// -----------------------------------------------------------------------------
// COMPLAINT STATUS LOOKUP
// -----------------------------------------------------------------------------

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
        ? `We could not find ticket ${ticketNumber.toUpperCase()} associated with your WhatsApp number.

Please verify the ticket number and try again.`
        : `There are currently no registered complaints associated with your WhatsApp number.

If you are experiencing an issue, describe it and we will help you register a complaint.`,
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
        ? `\n👤 Assigned to: ${complaint.assignee.name}`
        : ''
    }`
  })

  return {
    text: `Here is the latest status of your complaint:

${lines.join('\n\n')}

For further assistance, please reply to this message.`,
  }
}

// -----------------------------------------------------------------------------
// CUSTOMER FEEDBACK
// -----------------------------------------------------------------------------

async function handleRating(
  organizationId: string,
  customerId: string,
  ticketNumber: string,
  rating: number,
  conversationId?: string,
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

    if (conversationId) {
      await resetBotFlow(conversationId)
    }

    return {
      text: `Thank you for rating ticket ${ticketNumber.toUpperCase()} ${rating}/5.

Your feedback has been recorded successfully.

We appreciate your time and value your feedback. It helps us improve SmartServe services.`,
    }
  } catch (error) {
    log.error(
      {
        error,
        ticketNumber,
        customerId,
      },
      'Failed to submit WhatsApp feedback',
    )

    throw error
  }
}

// -----------------------------------------------------------------------------
// FEEDBACK REQUEST MESSAGE
// -----------------------------------------------------------------------------

export async function sendFeedbackRequestText(
  ticketNumber: string,
): Promise<string> {
  return `Your ticket ${ticketNumber} has been marked as resolved.

We would appreciate your feedback about the service.

Please rate the resolution by replying:

RATE ${ticketNumber} 5

You can provide any rating from 1 to 5.

1 = Poor
2 = Fair
3 = Average
4 = Good
5 = Excellent

Thank you for choosing SmartServe.`
}

// -----------------------------------------------------------------------------
// RESET CONVERSATION FLOW
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// MEDIA MESSAGE ACKNOWLEDGEMENT
// -----------------------------------------------------------------------------

/**
 * Use this helper when the inbound pipeline receives a photo, document
 * or voice note without a text transcription.
 *
 * This does not create a complaint automatically.
 */
export function getMediaAcknowledgement(
  mediaType: string,
): string {
  const type = mediaType.toLowerCase()

  if (type === 'image' || type === 'photo') {
    return `Thank you for sharing the image.

We have received your attachment.

Please describe the issue shown in the image so our team can assist you.`
  }

  if (
    type === 'audio' ||
    type === 'voice' ||
    type === 'voice_note' ||
    type === 'ptt'
  ) {
    return `Thank you for sharing the voice message.

We have received your audio attachment.

If you have not provided a text description, please briefly type the issue so we can assist you.`
  }

  if (type === 'video') {
    return `Thank you for sharing the video.

We have received your attachment.

Please briefly describe the issue shown in the video so our team can assist you.`
  }

  if (type === 'document' || type === 'file') {
    return `Thank you for sharing the document.

We have received your attachment.

Please explain what assistance you need regarding this document.`
  }

  return `Thank you for sharing your attachment.

Please describe how we can assist you.`
}

// -----------------------------------------------------------------------------
// EXPORTED BOT MESSAGES
// -----------------------------------------------------------------------------

export const BOT_MESSAGES = {
  GREETING,
  HELP_MESSAGE,
  CANCEL_MESSAGE,
  LOCATION_PROMPT,
  GENERAL_MESSAGE,
}
