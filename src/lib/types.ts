import { z } from 'zod'

// ============================================================
// Domain unions — DB stores plain strings; these are the only
// valid values, enforced at every API boundary with Zod.
// ============================================================

export const ROLES = ['SUPER_ADMIN', 'ORGANIZATION_ADMIN', 'SUPERVISOR', 'STAFF', 'VIEWER'] as const
export type Role = (typeof ROLES)[number]

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type Priority = (typeof PRIORITIES)[number]

export const COMPLAINT_STATUSES = ['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'] as const
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number]

export const WHATSAPP_STATUSES = ['NOT_CONNECTED', 'CONNECTING', 'CONNECTED', 'ERROR', 'DISCONNECTED'] as const
export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number]

export const MESSAGE_TYPES = ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'LOCATION', 'INTERACTIVE'] as const
export const MESSAGE_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const
export const MESSAGE_STATUSES = ['RECEIVED', 'SENT', 'DELIVERED', 'READ', 'FAILED'] as const
export const MESSAGE_SENDERS = ['CUSTOMER', 'STAFF', 'BOT', 'SYSTEM'] as const

export const AI_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DISABLED'] as const
export const AI_ANALYSIS_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const
export const SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const

export const SLA_STATES = ['WITHIN_SLA', 'APPROACHING', 'BREACHED', 'MET'] as const
export type SlaState = (typeof SLA_STATES)[number]

export const NOTIFICATION_TYPES = ['NEW_COMPLAINT', 'ASSIGNMENT', 'STATUS_CHANGE', 'SLA_WARNING', 'SLA_BREACH', 'ESCALATION', 'COMMENT', 'RESOLUTION'] as const
export const DUPLICATE_STATUSES = ['PENDING', 'LINKED', 'DISMISSED'] as const
export const BOT_FLOWS = ['IDLE', 'COLLECTING_DESCRIPTION', 'COLLECTING_LOCATION', 'CONFIRMING', 'FEEDBACK_RATING', 'FEEDBACK_COMMENT'] as const

/** Allowed status transitions (server-side validation, spec §22/§20). */
export const STATUS_TRANSITIONS: Record<ComplaintStatus, ComplaintStatus[]> = {
  NEW: ['ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'CLOSED'],
  ACKNOWLEDGED: ['ASSIGNED', 'IN_PROGRESS', 'CLOSED'],
  ASSIGNED: ['IN_PROGRESS', 'ACKNOWLEDGED', 'CLOSED'],
  IN_PROGRESS: ['RESOLVED', 'ASSIGNED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  CLOSED: ['REOPENED'],
  REOPENED: ['IN_PROGRESS', 'ASSIGNED', 'ACKNOWLEDGED', 'CLOSED'],
}

export const OPEN_STATUSES: ComplaintStatus[] = ['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED']

// ============================================================
// Zod schemas — request validation (never trust the frontend)
// ============================================================

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
})

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
})

export const passwordRequestSchema = z.object({ email: z.string().trim().toLowerCase().email() })
export const passwordResetSchema = z.object({ token: z.string().min(10), password: z.string().min(8).max(128) })

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  industry: z.string().trim().max(80).optional(),
})

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(40).optional(),
  website: z.string().trim().max(200).optional(),
  address: z.string().trim().max(300).optional(),
  industry: z.string().trim().max(80).optional(),
  logoUrl: z.string().trim().max(500).optional(),
  autoAssignment: z.boolean().optional(),
  onboardingStep: z.number().int().min(0).max(7).optional(),
})

export const joinOrganizationSchema = z.object({ code: z.string().trim().min(6).max(80) })

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['ORGANIZATION_ADMIN', 'SUPERVISOR', 'STAFF', 'VIEWER']).default('STAFF'),
  departmentId: z.string().trim().optional(),
})

export const updateMemberSchema = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  departmentId: z.string().nullable().optional(),
})

export const departmentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).optional(),
})
export const locationSchema = departmentSchema
export const categorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).optional(),
  departmentId: z.string().trim().optional(),
  defaultPriority: z.enum(PRIORITIES).default('MEDIUM'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
})

export const slaSchema = z.object({
  priority: z.enum(PRIORITIES),
  firstResponseMinutes: z.number().int().min(1).max(60 * 24 * 30),
  resolutionMinutes: z.number().int().min(1).max(60 * 24 * 60),
  escalationMinutes: z.number().int().min(1).max(60 * 24 * 60).nullable().optional(),
  enabled: z.boolean().default(true),
})

export const complaintListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().optional(),
  priority: z.string().trim().optional(),
  categoryId: z.string().trim().optional(),
  departmentId: z.string().trim().optional(),
  assignedTo: z.string().trim().optional(),
  customerId: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  slaState: z.enum(SLA_STATES).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'priority', 'status', 'slaDueAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
})

export const createComplaintSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  customerId: z.string().trim().optional(),
  customerName: z.string().trim().max(120).optional(),
  customerPhone: z.string().trim().min(6).max(24).optional(),
  categoryId: z.string().trim().optional(),
  departmentId: z.string().trim().optional(),
  locationId: z.string().trim().optional(),
  locationName: z.string().trim().max(120).optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
})

export const assignComplaintSchema = z.object({
  assignedTo: z.string().trim().min(1),
  reason: z.string().trim().max(300).optional(),
})

export const statusChangeSchema = z.object({
  status: z.enum(COMPLAINT_STATUSES),
  reason: z.string().trim().max(300).optional(),
})

export const priorityChangeSchema = z.object({
  priority: z.enum(PRIORITIES),
  reason: z.string().trim().max(300).optional(),
})

export const commentSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  visibility: z.enum(['INTERNAL', 'PUBLIC']).default('INTERNAL'),
})

export const replyMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
})

export const whatsappConnectSchema = z.object({
  wabaId: z.string().trim().min(1).max(80),
  phoneNumberId: z.string().trim().min(1).max(80),
  displayPhoneNumber: z.string().trim().min(4).max(24),
  accessToken: z.string().trim().min(8).max(600),
  verifyToken: z.string().trim().min(8).max(200).optional(),
  appSecret: z.string().trim().min(8).max(200).optional(),
})

export const feedbackSchema = z.object({
  ticketNumber: z.string().trim().min(4).max(20),
  phoneNumber: z.string().trim().min(6).max(24),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
})

export const linkDuplicateSchema = z.object({
  matchId: z.string().trim().min(1),
  action: z.enum(['LINK', 'DISMISS']),
})

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

// Helpers -------------------------------------------------------------------

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v)
}
export function isPriority(v: string): v is Priority {
  return (PRIORITIES as readonly string[]).includes(v)
}
export function isComplaintStatus(v: string): v is ComplaintStatus {
  return (COMPLAINT_STATUSES as readonly string[]).includes(v)
}

/** Numeric rank used for workload/priority math and sorting. */
export const PRIORITY_RANK: Record<Priority, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }
