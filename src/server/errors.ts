/**
 * Centralized API error type + safe error responses (spec §44/§53).
 * Internal details (DB errors, stack traces, provider credentials) are never
 * sent to clients — only safe, mapped messages.
 */

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }

  static badRequest(message = 'Invalid request', details?: unknown) {
    return new ApiError(400, 'BAD_REQUEST', message, details)
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHORIZED', message)
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, 'FORBIDDEN', message)
  }
  static notFound(message = 'Resource not found') {
    return new ApiError(404, 'NOT_FOUND', message)
  }
  static conflict(message = 'Resource conflict') {
    return new ApiError(409, 'CONFLICT', message)
  }
  static tooMany(message = 'Too many requests. Please slow down.') {
    return new ApiError(429, 'RATE_LIMITED', message)
  }
  static internal(message = 'Something went wrong. Please try again.') {
    return new ApiError(500, 'INTERNAL_ERROR', message)
  }
  static serviceUnavailable(service: string) {
    return new ApiError(503, 'SERVICE_UNAVAILABLE', `${service} is currently unavailable`)
  }
}

export function jsonOk(data: unknown, init?: ResponseInit) {
  return Response.json({ ok: true, data }, init)
}

export function jsonError(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json(
      { ok: false, error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status },
    )
  }
  // Unexpected errors are logged server-side, never exposed (spec §44).
  return Response.json(
    { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } },
    { status: 500 },
  )
}
