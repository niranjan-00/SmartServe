import { db } from '@/lib/db'
import { jsonOk, withApi } from '@/server/api'
import { APP_VERSION } from '@/server/version'
import { ensureBackgroundJobs } from '@/server/jobs'

/** Health check (spec §57/§60) — safe info only, never secrets. */
export const GET = withApi(async () => {
  ensureBackgroundJobs()
  let database = 'up'
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    database = 'down'
  }
  return jsonOk({
    status: database === 'up' ? 'healthy' : 'degraded',
    database,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  })
})
