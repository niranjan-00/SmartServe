
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Resolve the Baileys Worker URL.
 *
 * Production:
 *   WHATSAPP_WORKER_URL must point to the Render Worker service.
 *
 * Development:
 *   Falls back to localhost:3020.
 */
function getWorkerUrl(): string {
  const configuredUrl = process.env.WHATSAPP_WORKER_URL?.trim()

  if (!configuredUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'WHATSAPP_WORKER_URL is missing. Configure the Baileys Worker URL in Render environment variables.'
      )
    }

    return 'http://127.0.0.1:3020'
  }

  const normalizedUrl = configuredUrl.replace(/\/+$/, '')

  let parsedUrl: URL

  try {
    parsedUrl = new URL(normalizedUrl)
  } catch {
    throw new Error(
      'Invalid WHATSAPP_WORKER_URL. Provide a valid HTTP or HTTPS URL.'
    )
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(
      'WHATSAPP_WORKER_URL must use HTTP or HTTPS.'
    )
  }

  return normalizedUrl
}

/**
 * Communicate securely with the SmartServe Baileys Worker.
 *
 * Every request includes:
 *   - x-worker-secret authentication
 *   - JSON content type
 *   - Request timeout
 *   - No caching
 *
 * Supports GET, POST, DELETE and other HTTP methods.
 */
export async function callBaileysWorker(
  path: string,
  init: RequestInit = {}
): Promise<any> {
  const secret = process.env.WHATSAPP_WORKER_SECRET?.trim()

  if (!secret) {
    throw new Error(
      'WHATSAPP_WORKER_SECRET is not configured in the SmartServe server environment.'
    )
  }

  if (!path || typeof path !== 'string') {
    throw new Error('A valid Baileys Worker API path is required.')
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  const baseUrl = getWorkerUrl()
  const requestUrl = `${baseUrl}${normalizedPath}`

  // Preserve existing headers, including Headers instances.
  const headers = new Headers(init.headers)

  headers.set('content-type', 'application/json')
  headers.set('x-worker-secret', secret)

  let response: Response

  try {
    response = await fetch(requestUrl, {
      ...init,
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error)

    if (
      error instanceof Error &&
      error.name === 'TimeoutError'
    ) {
      throw new Error(
        `Baileys Worker request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds. Check whether the worker is running and reachable. URL: ${requestUrl}`
      )
    }

    throw new Error(
      `Unable to connect to Baileys Worker. Check WHATSAPP_WORKER_URL, Render service status and internal networking. URL: ${requestUrl}. Details: ${message}`
    )
  }

  // Read response safely, including non-JSON error responses.
  const responseText = await response.text()

  let data: any = {}

  if (responseText) {
    try {
      data = JSON.parse(responseText)
    } catch {
      if (!response.ok) {
        throw new Error(
          `Baileys Worker returned HTTP ${response.status} with an invalid response.`
        )
      }

      throw new Error(
        `Baileys Worker returned an invalid JSON response (HTTP ${response.status}).`
      )
    }
  }

  if (!response.ok) {
    const workerError =
      typeof data?.error === 'string'
        ? data.error
        : typeof data?.message === 'string'
          ? data.message
          : response.statusText || 'Unknown worker error'

    throw new Error(
      `Baileys Worker error (${response.status}): ${workerError}`
    )
  }

  return data
}
