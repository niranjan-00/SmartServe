/** Next.js server-start hook — boots the background SLA monitor exactly once. */
export async function register() {
  // Node-only: dynamic import keeps Edge builds clean (jobs.ts pulls in Prisma + node:crypto)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureBackgroundJobs } = await import('@/server/jobs')
    try {
      ensureBackgroundJobs()
    } catch {
      // background jobs are best-effort; API routes still function
    }
  }
}
