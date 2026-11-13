import { withApi, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { db } from '@/lib/db'
import { emitToOrganization } from '@/server/realtime'
import { ApiError } from '@/server/errors'

export const runtime = 'nodejs'

type WahaSession = {
  name?: string
  status?: string
  me?: { id?: string; pushName?: string } | null
}

type WahaQrJson = { mimetype?: string; data?: string; value?: string; qr?: string }

function config() {
  const baseUrl = (process.env.WAHA_BASE_URL?.trim() || 'https://waha-aelr.onrender.com').replace(/\/+$/, '')
  const apiKey = process.env.WAHA_API_KEY?.trim()
  if (!baseUrl || !apiKey) {
    throw new ApiError(503, 'WAHA_NOT_CONFIGURED', 'SmartServe is missing its server-side WAHA URL or API key.')
  }
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch {
    throw new ApiError(503, 'WAHA_INVALID_URL', 'WAHA_BASE_URL must be a valid URL.')
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new ApiError(503, 'WAHA_HTTPS_REQUIRED', 'The deployed WAHA service must use HTTPS.')
  }
  return { baseUrl, apiKey }
}

async function request<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, accept = 'application/json') {
  const { baseUrl, apiKey } = config()
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Accept: accept, 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Network request failed'
    throw new ApiError(502, 'WAHA_UNREACHABLE', `SmartServe could not reach WAHA: ${detail}`)
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new ApiError(response.status === 404 ? 404 : 502, 'WAHA_REQUEST_FAILED', detail || `WAHA returned HTTP ${response.status}.`)
  }
  return response
}

async function getOrganizationSession(organizationId: string) {
  const connection = await db.whatsAppConnection.findUnique({ where: { organizationId } })
  if (!connection || !connection.statusMessage?.startsWith('waha-adapter') || !connection.wahaSessionName) {
    throw new ApiError(409, 'WHATSAPP_NOT_INITIALIZED', 'Start the WhatsApp connection first.')
  }
  return connection
}

async function sessionInfo(sessionName: string): Promise<WahaSession | null> {
  try {
    const response = await request(`/api/sessions/${encodeURIComponent(sessionName)}`)
    return await response.json() as WahaSession
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

async function initializeSession(organizationId: string, sessionName: string) {
  const webhookSecret = process.env.WAHA_WEBHOOK_SECRET?.trim()
  if (process.env.NODE_ENV === 'production' && !webhookSecret) {
    throw new ApiError(503, 'WAHA_WEBHOOK_SECRET_REQUIRED', 'Set WAHA_WEBHOOK_SECRET in SmartServe before connecting WhatsApp.')
  }
  let session = await sessionInfo(sessionName)
  if (!session) {
    const appUrl = (process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '')
    if (!appUrl) throw new ApiError(503, 'APP_URL_NOT_CONFIGURED', 'Set APP_URL or NEXTAUTH_URL so WAHA can send incoming-message webhooks to SmartServe.')
    const webhookUrl = `${appUrl}/api/webhooks/whatsapp`
    const response = await request('/api/sessions', 'POST', {
      name: sessionName,
      config: { webhooks: [{
        url: webhookUrl,
        events: ['message', 'session.status'],
        ...(webhookSecret ? { hmac: { key: webhookSecret } } : {}),
        retries: { policy: 'exponential', delaySeconds: 2, attempts: 5 },
      }] },
    })
    session = await response.json() as WahaSession
  }
  if (!session.status || ['STOPPED', 'FAILED'].includes(session.status.toUpperCase())) {
    const operation = session.status?.toUpperCase() === 'FAILED' ? 'restart' : 'start'
    const response = await request(`/api/sessions/${encodeURIComponent(sessionName)}/${operation}`, 'POST', {})
    session = await response.json().catch(() => ({ name: sessionName, status: 'STARTING' })) as WahaSession
  }
  await db.whatsAppConnection.update({
    where: { organizationId },
    data: { status: session.status === 'WORKING' ? 'CONNECTED' : 'CONNECTING', statusMessage: `waha-adapter: ${session.status || 'STARTING'}`, lastVerifiedAt: session.status === 'WORKING' ? new Date() : undefined },
  })
  return session
}

async function qrDataUrl(sessionName: string): Promise<string | null> {
  const response = await request(`/api/${encodeURIComponent(sessionName)}/auth/qr`, 'GET', undefined, 'image/png, application/json')
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  if (contentType.startsWith('image/')) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length ? `data:${contentType.split(';')[0]};base64,${bytes.toString('base64')}` : null
  }
  const data = await response.json().catch(() => null) as WahaQrJson | null
  const raw = data?.data || data?.value || data?.qr
  if (!raw) return null
  return raw.startsWith('data:') ? raw : `data:${data?.mimetype || 'image/png'};base64,${raw}`
}

export const GET = withApi(async () => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')
  const connection = await getOrganizationSession(ctx.organizationId)
  const session = await sessionInfo(connection.wahaSessionName!)
  const status = session?.status?.toUpperCase() || 'UNKNOWN'
  const me = status === 'WORKING' ? session?.me || await (await request(`/api/sessions/${encodeURIComponent(connection.wahaSessionName!)}/me`)).json().catch(() => null) : null
  const phone = me?.id?.split('@')[0] || null
  await db.whatsAppConnection.update({
    where: { organizationId: ctx.organizationId },
    data: {
      status: status === 'WORKING' ? 'CONNECTED' : status === 'FAILED' ? 'ERROR' : 'CONNECTING',
      statusMessage: `waha-adapter: ${status}`,
      ...(phone ? { displayPhoneNumber: phone } : {}),
      ...(status === 'WORKING' ? { lastVerifiedAt: new Date() } : {}),
    },
  })
  return jsonOk({ session: connection.wahaSessionName, status, connected: status === 'WORKING', phoneNumber: phone, pushName: me?.pushName || null })
})

export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')
  const body = await req.json().catch(() => ({})) as { action?: string }
  const action = body.action || 'start'
  const connection = await getOrganizationSession(ctx.organizationId)
  const sessionName = connection.wahaSessionName!

  if (action === 'start') {
    const session = await initializeSession(ctx.organizationId, sessionName)
    await emitToOrganization(ctx.organizationId, 'whatsapp.status_changed', { status: session.status || 'STARTING' })
    return jsonOk({ ok: true, session: sessionName, status: session.status || 'STARTING', message: 'WhatsApp session is initializing.' })
  }

  if (action === 'qr') {
    const session = await sessionInfo(sessionName)
    const status = session?.status?.toUpperCase() || 'UNKNOWN'
    if (status === 'WORKING') return jsonOk({ ok: true, session: sessionName, status, connected: true, qr: null, message: 'WhatsApp is already connected.' })
    if (status !== 'SCAN_QR_CODE') return jsonOk({ ok: true, session: sessionName, status, connected: false, qr: null, message: `WhatsApp is ${status}. The QR code is available when WAHA reports SCAN_QR_CODE.` })
    const qr = await qrDataUrl(sessionName)
    return jsonOk({ ok: true, session: sessionName, status, connected: false, qr, message: qr ? 'Scan this QR code using WhatsApp → Linked Devices → Link a Device.' : 'WAHA has not returned a QR code yet. Try again shortly.' })
  }

  if (action === 'verify') {
    const session = await sessionInfo(sessionName)
    const status = session?.status?.toUpperCase() || 'UNKNOWN'
    const me = status === 'WORKING' ? await (await request(`/api/sessions/${encodeURIComponent(sessionName)}/me`)).json().catch(() => null) as WahaSession['me'] : null
    const phone = me?.id?.split('@')[0] || null
    await db.whatsAppConnection.update({
      where: { organizationId: ctx.organizationId },
      data: {
        status: status === 'WORKING' ? 'CONNECTED' : status === 'FAILED' ? 'ERROR' : 'CONNECTING',
        statusMessage: `waha-adapter: ${status}`,
        ...(phone ? { displayPhoneNumber: phone } : {}),
        ...(status === 'WORKING' ? { lastVerifiedAt: new Date() } : {}),
      },
    })
    return jsonOk({ ok: true, session: sessionName, status, connected: status === 'WORKING', phoneNumber: phone, pushName: me?.pushName || null })
  }

  throw new ApiError(400, 'INVALID_WAHA_ACTION', 'Action must be start, qr, or verify.')
})
