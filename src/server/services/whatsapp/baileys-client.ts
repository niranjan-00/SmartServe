const workerUrl = () => (process.env.WHATSAPP_WORKER_URL || 'http://127.0.0.1:3020').replace(/\/$/, '')

export async function callBaileysWorker(path: string, init: RequestInit = {}) {
  const secret = process.env.WHATSAPP_WORKER_SECRET
  if (!secret) throw new Error('WHATSAPP_WORKER_SECRET is not configured')
  const response = await fetch(`${workerUrl()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-worker-secret': secret, ...(init.headers || {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  })
  const data = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(data.error || `Baileys worker returned ${response.status}`)
  return data
}
