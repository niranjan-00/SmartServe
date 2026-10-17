import { withApi, jsonOk } from '@/server/api'
import { requireOrganization, requirePermission } from '@/server/authz'
import { WahaWhatsAppProvider } from '@/server/services/whatsapp/waha-provider'
import { ApiError } from '@/server/errors'

type WahaSession = {
  name?: string
  status?: string
  me?: { id?: string; pushName?: string }
}

type WahaQrJson = {
  mimetype?: string
  data?: string
  value?: string
  qr?: string
}

type WahaAction = 'verify' | 'start' | 'qr'

function getWahaConfig() {
  const baseUrl = process.env.WAHA_BASE_URL?.trim().replace(/\/+$/, '')
  const apiKey = process.env.WAHA_API_KEY?.trim()
  const session = process.env.WAHA_SESSION?.trim() || 'default'

  if (!baseUrl || !apiKey) {
    throw new ApiError(
      503,
      'WAHA_NOT_CONFIGURED',
      'Configure WAHA_BASE_URL and WAHA_API_KEY in the SmartServe server environment.',
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
    throw new ApiError(503, 'WAHA_HTTPS_REQUIRED', 'Use HTTPS for the deployed WAHA service.')
  }

  return { baseUrl, apiKey, session }
}

async function wahaJson<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${baseUrl}${path}`, {
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
  } catch {
    throw new ApiError(502, 'WAHA_UNAVAILABLE', 'Could not reach WAHA. Check the Render service and its URL.')
  }

  const text = await response.text()
  let data: unknown = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
        ? data.message
        : typeof data === 'string'
          ? data.slice(0, 240)
          : `WAHA returned HTTP ${response.status}.`

    throw new ApiError(502, 'WAHA_REQUEST_FAILED', message)
  }

  return data as T
}

async function getQrDataUrl(baseUrl: string, apiKey: string, session: string): Promise<string | null> {
  let response: Response

  try {
    response = await fetch(
      `${baseUrl}/api/${encodeURIComponent(session)}/auth/qr`,
      {
        method: 'GET',
        headers: {
          Accept: 'image/png, image/jpeg, application/json',
          'X-Api-Key': apiKey,
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      },
    )
  } catch {
    throw new ApiError(502, 'WAHA_QR_UNAVAILABLE', 'Could not retrieve the WAHA QR code.')
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new ApiError(
      502,
      'WAHA_QR_FAILED',
      details.slice(0, 240) || `WAHA QR endpoint returned HTTP ${response.status}.`,
    )
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() || ''

  // Some WAHA versions return the QR code directly as a PNG/JPEG image.
  if (contentType.startsWith('image/')) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length) return null
    const mime = contentType.includes('jpeg') || contentType.includes('jpg') ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  // Other versions return JSON with a base64 QR value.
  const data = (await response.json().catch(() => null)) as WahaQrJson | null
  const raw = data?.data || data?.value || data?.qr
  if (!raw) return null
  if (raw.startsWith('data:')) return raw

  const mime = data?.mimetype || 'image/png'
  return `data:${mime};base64,${raw}`
}

export const POST = withApi(async (req) => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')

  const rawBody: unknown = await req.json().catch(() => ({}))
  const actionValue =
    typeof rawBody === 'object' &&
    rawBody !== null &&
    'action' in rawBody &&
    typeof rawBody.action === 'string'
      ? rawBody.action
      : 'verify'

  if (!['verify', 'start', 'qr'].includes(actionValue)) {
    throw new ApiError(400, 'WAHA_INVALID_ACTION', 'Action must be verify, start, or qr.')
  }

  const action = actionValue as WahaAction
  const { baseUrl, apiKey, session } = getWahaConfig()

  if (action === 'start') {
    const result = await wahaJson<WahaSession>(
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
      status: result.status || 'STARTING',
      message: `Start requested for WAHA session "${session}". If it needs authentication, retrieve the QR code next.`,
    })
  }

  if (action === 'qr') {
    const qr = await getQrDataUrl(baseUrl, apiKey, session)

    return jsonOk({
      ok: true,
      session,
      qr,
      message: qr
        ? 'QR code retrieved. Scan it from WhatsApp > Linked devices > Link a device.'
        : 'WAHA returned no QR code. Start the session first, then try again. A QR may not be available if the session is already authenticated.',
    })
  }

  const provider = new WahaWhatsAppProvider()
  const verification = await provider.verifyConnection()

  if (!verification.ok) {
    throw new ApiError(
      502,
      'WAHA_SESSION_UNAVAILABLE',
      verification.error || `WAHA session "${session}" is not ready.`,
    )
  }

  const status = await wahaJson<WahaSession>(
    baseUrl,
    apiKey,
    `/api/sessions/${encodeURIComponent(session)}`,
  )

  return jsonOk({
    ok: true,
    connected: true,
    mode: 'waha',
    session,
    status: status.status || 'WORKING',
    message: `WAHA session "${session}" is working. This verifies the session; SmartServe's active provider selection and inbound webhook still need to be configured separately.`,
  })
})
