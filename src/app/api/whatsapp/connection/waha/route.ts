import { withApi, jsonOk } from '@/server/api'
import {
  requireOrganization,
  requirePermission,
} from '@/server/authz'
import { WahaWhatsAppProvider } from '@/server/services/whatsapp/waha-provider'
import { ApiError } from '@/server/errors'

export const POST = withApi(async () => {
  const ctx = await requireOrganization()
  await requirePermission(ctx, 'whatsapp:manage')

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
    throw new ApiError(
      503,
      'WAHA_INVALID_URL',
      'WAHA_BASE_URL must be a valid URL.',
    )
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

  const provider = new WahaWhatsAppProvider()

  let verification: Awaited<ReturnType<typeof provider.verifyConnection>>

  try {
    verification = await provider.verifyConnection()
  } catch {
    throw new ApiError(
      502,
      'WAHA_UNAVAILABLE',
      'Could not contact WAHA. Check the WAHA service, API key, and session.',
    )
  }

  if (!verification.ok) {
    throw new ApiError(
      502,
      'WAHA_SESSION_UNAVAILABLE',
      verification.error ||
        `WAHA session "${session}" is not ready. Start the session in WAHA first.`,
    )
  }

  return jsonOk({
    connected: true,
    mode: 'waha',
    session,
    message: 'WAHA connection verified.',
  })
})