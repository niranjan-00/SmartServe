import { ApiError, jsonError, jsonOk } from '@/server/errors'
import { createLogger } from '@/server/logger'

const log = createLogger('api')

/**
 * Route-handler wrapper: authentication, RBAC and input validation run here;
 * handlers only implement business logic. Every endpoint returns
 * { ok, data } or { ok, error: { code, message } } (spec §42-44).
 */

interface HandlerParams<P> {
  params: P
}

export function withApi<P = unknown>(
  handler: (req: Request, ctx: HandlerParams<P>) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<P> } | undefined): Promise<Response> => {
    const started = Date.now()
    try {
      const params = ctx?.params ? await ctx.params : ({} as P)
      const res = await handler(req, { params })
      log.debug('request', { method: req.method, url: new URL(req.url).pathname, ms: Date.now() - started })
      return res
    } catch (error) {
      if (!(error instanceof ApiError)) {
        log.error('request.failed', {
          method: req.method,
          url: new URL(req.url).pathname,
          ms: Date.now() - started,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return jsonError(error)
    }
  }
}

export async function readJson<T>(req: Request, schema: { safeParse: (v: unknown) => { success: boolean; data: T; error?: { issues: unknown[] } } }): Promise<T> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON')
  }
  const result = schema.safeParse(body)
  if (!result.success) {
    const issues = result.error?.issues ?? []
    const first = issues[0] as { path?: (string | number)[]; message?: string } | undefined
    const path = first?.path?.join('.') || 'body'
    throw ApiError.badRequest(`Invalid value for ${path}: ${first?.message || 'validation failed'}`, issues)
  }
  return result.data
}

export function readQuery<T>(req: Request, schema: { safeParse: (v: unknown) => { success: boolean; data: T; error?: { issues: unknown[] } } }): T {
  const url = new URL(req.url)
  const raw: Record<string, string> = {}
  url.searchParams.forEach((v, k) => {
    raw[k] = v
  })
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error?.issues ?? []
    const first = issues[0] as { path?: (string | number)[]; message?: string } | undefined
    const path = first?.path?.join('.') || 'query'
    throw ApiError.badRequest(`Invalid query parameter ${path}: ${first?.message || 'validation failed'}`, issues)
  }
  return result.data
}

export { jsonOk, jsonError }
