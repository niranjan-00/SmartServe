/**
 * Status transition matrix — mirrors src/lib/types.ts STATUS_TRANSITIONS.
 * Kept as a helper so tests run without importing the full server bundle.
 */

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  NEW: ['ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'CLOSED'],
  ACKNOWLEDGED: ['ASSIGNED', 'IN_PROGRESS', 'CLOSED'],
  ASSIGNED: ['IN_PROGRESS', 'ACKNOWLEDGED', 'CLOSED'],
  IN_PROGRESS: ['RESOLVED', 'ASSIGNED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  CLOSED: ['REOPENED'],
  REOPENED: ['IN_PROGRESS', 'ASSIGNED', 'ACKNOWLEDGED', 'CLOSED'],
}

export function computeTransitionGuard(from: string, to: string): boolean {
  return (STATUS_TRANSITIONS[from] ?? []).includes(to)
}
