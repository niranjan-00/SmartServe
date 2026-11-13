import { jsonError, ApiError } from '@/server/errors'

/** Legacy single-number credential endpoint intentionally retired. */
export async function GET() {
  return jsonError(new ApiError(410, 'LEGACY_WHATSAPP_ENDPOINT', 'This endpoint has been retired. Use /api/whatsapp/accounts for Baileys QR connections.'))
}
export async function POST() {
  return jsonError(new ApiError(410, 'LEGACY_WHATSAPP_ENDPOINT', 'Meta credential onboarding has been replaced by Baileys QR onboarding.'))
}
export async function DELETE() {
  return jsonError(new ApiError(410, 'LEGACY_WHATSAPP_ENDPOINT', 'Disconnect a specific number using /api/whatsapp/accounts/:id.'))
}
