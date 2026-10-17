import { withApi, jsonOk, readJson } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { WahaWhatsAppProvider } from '@/server/services/whatsapp/waha-provider'
import { ApiError } from '@/server/errors'

type WahaAction = 'verify' | 'start' | 'qr'

type WahaSession = {
  name?: string
  status?: string
  me?: {
    id?: string
    pushName?: string
  }
}

type WahaQr = {
  mimetype?: string
  data?: string
  value?: string
}

async function wahaRequest<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })

  const text = await response.text()
  let data: unknown

  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  if (!response.ok) {
    const detail =
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
        ? data.message
        : `WAHA returned HTTP ${response.status}`

    throw new ApiError(502, 'WAHA_REQUEST_FAILED', detail)
  }

  return data as T
}

export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')

  const rawBody: unknown = await req.json().catch(() => ({}))

  const action =
    typeof rawBody === 'object' &&
    rawBody !== null &&
    'action' in rawBody &&
    typeof rawBody.action === 'string'
      ? rawBody.action
      : 'verify'

  if (!['verify', 'start', 'qr'].includes(action)) {
    throw new ApiError(
      400,
      'INVALID_WAHA_ACTION',
      'Action must be verify, start, or qr.',
    )
  }

  const baseUrl = process.env.WAHA_BASE_URL?.trim()
  const apiKey = process.env.WAHA_API_KEY?.trim()
  const session = process.env.WAHA_SESSION?.trim() || 'default'

  if (!baseUrl || !apiKey) {
    throw new ApiError(
      503,
      'WAHA_NOT_CONFIGURED',
      'Configure WAHA_BASE_URL and WAHA_API_KEY in the SmartServe environment.',
    )
  }

  let parsedUrl: URL

  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new ApiError(503, 'WAHA_INVALID_URL', 'WAHA_BASE_URL must be a valid URL.')
  }

  if (
    parsedUrl.protocol !== 'https:' &&
    parsedUrl.hostname !== 'localhost' &&
    parsedUrl.hostname !== '127.0.0.1'
  ) {
    throw new ApiError(
      503,
      'WAHA_HTTPS_REQUIRED',
      'Use HTTPS for the deployed WAHA service.',
    )
  }

  try {
    if (action === 'start') {
      // Start an existing session. WAHA may return a QR-required state.
      const result = await wahaRequest<WahaSession>(
        baseUrl,
        apiKey,
        '/api/sessions/start',
        'POST',
        { name: session },
      )

      return jsonOk({
        ok: true,
        mode: 'waha',
        session,
        status: result.status ?? 'STARTING',
        message: 'WAHA session start requested. Check session status and QR if needed.',
      })
    }

    if (action === 'qr') {
      const qr = await wahaRequest<WahaQr>(
        baseUrl,
        apiKey,
        `/api/${encodeURIComponent(session)}/auth/qr`,
      )

      const qrData = qr.data ?? qr.value

      return jsonOk({
        ok: true,
        session,
        qr: qrData
          ? qrData.startsWith('data:')
            ? qrData
            : `data:${qr.mimetype || 'image/png'};base64,${qrData}`
          : null,
        message: qrData
          ? 'Scan this QR code with WhatsApp.'
          : 'WAHA did not return a QR code. The session may already be authenticated.',
      })
    }

    const provider = new WahaWhatsAppProvider()
    const verification = await provider.verifyConnection()

    if (!verification.ok) {
      throw new ApiError(
        502,
        'WAHA_SESSION_UNAVAILABLE',
        verification.error ?? `WAHA session "${session}" is not ready.`,
      )
    }

    return jsonOk({
      ok: true,
      connected: true,
      mode: 'waha',
      session,
      message: 'WAHA session is working.',
    })
  } catch (error) {
    if (error instanceof ApiError) throw error

    throw new ApiError(
      502,
      'WAHA_UNAVAILABLE',
      error instanceof Error
        ? error.message
        : 'Could not contact WAHA. Check the service, API key, and session.',
    )
  }
})