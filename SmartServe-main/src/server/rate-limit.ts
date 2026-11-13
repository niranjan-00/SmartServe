/**
 * In-memory sliding-window rate limiter (spec §45).
 * Production note: swap the Map for Redis when running multi-instance —
 * the call signature stays identical.
 */

interface Bucket {
  timestamps: number[]
}

const buckets = new Map<string, Bucket>()
let lastSweep = Date.now()

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs)
    if (bucket.timestamps.length === 0) buckets.delete(key)
  }
}

/**
 * Returns remaining attempts or throws 429.
 * @param key     unique key, e.g. `login:ip:1.2.3.4` or `search:org:userId`
 * @param limit   max requests per window
 * @param windowMs window length in ms
 */
export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now()
  sweep(now, windowMs)
  const bucket = buckets.get(key) ?? { timestamps: [] }
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs)
  if (bucket.timestamps.length >= limit) {
    const retryAfterMs = windowMs - (now - bucket.timestamps[0])
    const error = new Error('Too many requests. Please slow down.') as Error & { status?: number; retryAfterMs?: number }
    error.status = 429
    error.retryAfterMs = retryAfterMs
    throw error
  }
  bucket.timestamps.push(now)
  buckets.set(key, bucket)
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') || '0.0.0.0'
}
