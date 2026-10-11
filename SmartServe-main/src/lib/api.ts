/**
 * Typed API client. Every response follows { ok, data } | { ok, error }.
 * Client code never talks to Prisma — only to these services (spec §48/§62).
 */

export class ApiClientError extends Error {
  code: string
  status: number
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }

  /** True when the session is missing/expired → caller should sign in. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'NO_ORGANIZATION'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers || {}),
    },
    credentials: 'same-origin',
  })

  let json: { ok?: boolean; data?: T; error?: { code: string; message: string; details?: unknown } } | null = null
  try {
    json = await res.json()
  } catch {
    throw new ApiClientError(res.status, 'BAD_RESPONSE', 'The server returned an unexpected response')
  }

  if (!res.ok || !json?.ok) {
    throw new ApiClientError(
      res.status,
      json?.error?.code ?? 'UNKNOWN',
      json?.error?.message ?? 'Request failed',
      json?.error?.details,
    )
  }
  return json.data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// ---------------------------------------------------------------------------
// Shared DTO shapes (mirrors of the server payloads)
// ---------------------------------------------------------------------------

export interface SessionUser {
  id?: string
  name?: string | null
  email?: string | null
  image?: string | null
}

export interface OrganizationInfo {
  id: string
  name: string
  slug: string
  logoUrl: string | null
  email: string | null
  phone: string | null
  website: string | null
  address: string | null
  industry: string | null
  onboardingStep: number
  autoAssignment: boolean
  createdAt: string
}

export interface ComplaintRow {
  id: string
  ticketNumber: string
  title: string
  status: string
  priority: string
  createdAt: string
  slaState: string
  slaDueAt: string | null
  customer: { id: string; name: string | null; phoneNumber: string }
  category?: { id: string; name: string } | null
  department?: { id: string; name: string } | null
  assignee?: { id: string; name: string | null; image?: string | null } | null
}

export interface ComplaintListResponse {
  items: ComplaintRow[]
  total: number
  page: number
  pageSize: number
  pages: number
}

export interface DashboardOverview {
  complaintsToday: number
  openComplaints: number
  resolvedComplaints: number
  averageResolutionHours: number | null
  slaCompliance: number | null
  customerSatisfaction: number | null
  trend: Array<{ day: string; received: number; resolved: number }>
  categoryDistribution: Array<{ name: string; count: number }>
  priorityDistribution: Array<{ name: string; count: number }>
  departmentStatistics: Array<{ name: string; total: number; open: number; resolved: number }>
  staffWorkload: Array<{ userId: string; name: string; open: number; resolved: number }>
  recentComplaints: Array<ComplaintRow & { category: string | null; department: string | null; assignee: string | null }>
  liveActivity: Array<{ id: string; action: string; description: string; actor: string; createdAt: string }>
}

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

export interface NotificationRow {
  id: string
  type: string
  title: string
  message: string
  complaintId: string | null
  readAt: string | null
  createdAt: string
  complaint?: { ticketNumber: string } | null
}

export interface MemberRow {
  id: string
  role: string
  status: string
  departmentId: string | null
  createdAt: string
  user: { id: string; name: string | null; email: string; image: string | null }
  department?: { id: string; name: string } | null
}

export interface DepartmentRow {
  id: string
  name: string
  description: string | null
  staffCount: number
  complaintCount: number
  openComplaints: number
  resolvedComplaints: number
  categoryCount: number
}

export interface CategoryRow {
  id: string
  name: string
  description: string | null
  defaultPriority: string
  status: string
  departmentId: string | null
  department?: { id: string; name: string } | null
  complaintCount: number
}

export interface LocationRow {
  id: string
  name: string
  description: string | null
  complaintCount: number
}

export interface StaffMetricRow {
  userId: string
  name: string | null
  email: string
  image: string | null
  role: string
  department: string | null
  assigned: number
  resolved: number
  openTickets: number
  averageResolutionHours: number | null
  slaCompliance: number | null
  customerRating: number | null
}
