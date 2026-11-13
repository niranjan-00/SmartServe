
import { safeEqual } from '@/server/crypto'
import { processBaileysInbound } from '@/server/services/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // 1. Authenticate the Baileys worker
  const expectedSecret = process.env.WHATSAPP_WORKER_SECRET
  const suppliedSecret = req.headers.get('x-worker-secret')

  if (
    !expectedSecret ||
    !suppliedSecret ||
    !safeEqual(expectedSecret, suppliedSecret)
  ) {
    return Response.json(
      { success: false, error: 'Unauthorized worker request' },
      { status: 401 }
    )
  }

  // 2. Parse and validate the incoming payload
  let payload: unknown

  try {
    payload = await req.json()
  } catch {
    return Response.json(
      { success: false, error: 'Invalid JSON payload' },
      { status: 400 }
    )
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return Response.json(
      { success: false, error: 'Invalid inbound message payload' },
      { status: 400 }
    )
  }

  try {
    // 3. Process the incoming WhatsApp message
    const result = await processBaileysInbound(payload)

    return Response.json({
      success: true,
      ...(
        result && typeof result === 'object'
          ? result
          : { result }
      ),
    })
  } catch (error) {
    console.error('[WhatsApp Inbound] Processing failed:', error)

    return Response.json(
      {
        success: false,
        error: 'Inbound message processing failed',
      },
      { status: 500 }
    )
  }
}
