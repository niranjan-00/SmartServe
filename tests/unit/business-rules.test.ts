import { describe, it, expect } from 'vitest'
import { STATUS_TRANSITIONS, computeTransitionGuard } from '../helpers/status-machine'
import { RuleBasedProvider } from '../../src/server/services/ai/index'
import { computeSlaDueAt, computeSlaState, DEFAULT_SLA } from '../../src/server/services/sla-service'
import { pickBestStaff, scoreStaff, type AssignableStaff } from '../../src/server/services/assignment-service'

/**
 * Core business-rule tests (spec §58): status transitions, AI fallback
 * classification, SLA computation, assignment scoring.
 */

describe('complaint status machine', () => {
  it('allows NEW → ACKNOWLEDGED / ASSIGNED / IN_PROGRESS / CLOSED', () => {
    expect(computeTransitionGuard('NEW', 'ACKNOWLEDGED')).toBe(true)
    expect(computeTransitionGuard('NEW', 'ASSIGNED')).toBe(true)
    expect(computeTransitionGuard('NEW', 'IN_PROGRESS')).toBe(true)
    expect(computeTransitionGuard('NEW', 'CLOSED')).toBe(true)
  })

  it('rejects illegal transitions', () => {
    expect(computeTransitionGuard('RESOLVED', 'IN_PROGRESS')).toBe(false)
    expect(computeTransitionGuard('CLOSED', 'RESOLVED')).toBe(false)
    expect(computeTransitionGuard('NEW', 'RESOLVED')).toBe(false)
    expect(computeTransitionGuard('CLOSED', 'IN_PROGRESS')).toBe(false)
  })

  it('allows reopen from RESOLVED and CLOSED', () => {
    expect(computeTransitionGuard('RESOLVED', 'REOPENED')).toBe(true)
    expect(computeTransitionGuard('CLOSED', 'REOPENED')).toBe(true)
  })

  it('every status has at least one transition', () => {
    for (const status of Object.keys(STATUS_TRANSITIONS)) {
      expect(STATUS_TRANSITIONS[status as keyof typeof STATUS_TRANSITIONS].length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// AI rules fallback (spec §24/§69)
// ---------------------------------------------------------------------------

const rules = new RuleBasedProvider()

describe('rule-based AI fallback classification', () => {
  it('classifies AC complaints as Maintenance/Facilities/HIGH', () => {
    const result = rules.classifyComplaint({
      text: 'The AC in room 204 is not working and it is extremely hot',
      categories: ['Maintenance', 'IT Support'],
      departments: ['Facilities', 'IT'],
      locations: ['Room 204'],
    })
    expect(result.category).toBe('Maintenance')
    expect(result.department).toBe('Facilities')
    expect(['HIGH', 'CRITICAL']).toContain(result.priority)
    expect(result.location).toBe('Room 204')
    expect(result.sentiment).toBe('NEGATIVE')
  })

  it('classifies wifi complaints as IT Support', () => {
    const result = rules.classifyComplaint({
      text: 'Wifi is not working in the library',
      categories: ['IT Support'],
      departments: ['IT'],
      locations: [],
    })
    expect(result.category).toBe('IT Support')
  })

  it('never blocks creation — always returns a result', () => {
    const result = rules.classifyComplaint({ text: 'something odd', categories: [], departments: [], locations: [] })
    expect(result.title.length).toBeGreaterThan(0)
    expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(result.priority)
  })

  it('produces a valid suggestion', () => {
    const result = rules.suggestResolution({ text: 'AC not cooling', category: 'Maintenance', department: 'Facilities' })
    expect(result.suggestion.length).toBeGreaterThan(20)
    expect(result.estimatedResolutionTime).toMatch(/\d/)
  })
})

// ---------------------------------------------------------------------------
// SLA (spec §30-32)
// ---------------------------------------------------------------------------

describe('SLA computation', () => {
  it('computes slaDueAt from policy resolution minutes', () => {
    const createdAt = new Date('2026-01-01T10:00:00Z')
    const due = computeSlaDueAt(createdAt, DEFAULT_SLA.HIGH)
    expect(due.getTime() - createdAt.getTime()).toBe(DEFAULT_SLA.HIGH.resolutionMinutes * 60_000)
  })

  it('BREACHED when open and past due', () => {
    const now = new Date('2026-01-01T13:00:00Z')
    const state = computeSlaState(
      { status: 'IN_PROGRESS', slaDueAt: new Date('2026-01-01T12:00:00Z'), createdAt: new Date('2026-01-01T10:00:00Z'), resolvedAt: null },
      now,
    )
    expect(state).toBe('BREACHED')
  })

  it('APPROACHING at >=80% of the window', () => {
    const createdAt = new Date('2026-01-01T10:00:00Z')
    const slaDueAt = new Date(createdAt.getTime() + 60 * 60_000)
    const now = new Date(createdAt.getTime() + 50 * 60_000) // 83% consumed
    const state = computeSlaState({ status: 'ASSIGNED', slaDueAt, createdAt, resolvedAt: null }, now)
    expect(state).toBe('APPROACHING')
  })

  it('WITHIN_SLA early in the window', () => {
    const createdAt = new Date('2026-01-01T10:00:00Z')
    const slaDueAt = new Date(createdAt.getTime() + 60 * 60_000)
    const now = new Date(createdAt.getTime() + 10 * 60_000)
    const state = computeSlaState({ status: 'NEW', slaDueAt, createdAt, resolvedAt: null }, now)
    expect(state).toBe('WITHIN_SLA')
  })

  it('MET when resolved before due', () => {
    const state = computeSlaState({
      status: 'RESOLVED',
      slaDueAt: new Date('2026-01-01T12:00:00Z'),
      createdAt: new Date('2026-01-01T10:00:00Z'),
      resolvedAt: new Date('2026-01-01T11:30:00Z'),
    })
    expect(state).toBe('MET')
  })
})

// ---------------------------------------------------------------------------
// Auto-assignment scoring (spec §26)
// ---------------------------------------------------------------------------

describe('assignment scoring', () => {
  const staff: AssignableStaff[] = [
    { userId: 'a', name: 'A', departmentId: 'dept-it', skills: ['wifi', 'network'], openCount: 5 },
    { userId: 'b', name: 'B', departmentId: 'dept-it', skills: [], openCount: 1 },
    { userId: 'c', name: 'C', departmentId: 'dept-hr', skills: [], openCount: 0 },
  ]

  it('prefers department + skill match', () => {
    const best = pickBestStaff(staff, { departmentId: 'dept-it', skillHint: 'wifi' })
    expect(best?.userId).toBe('a')
  })

  it('prefers low workload when no skills match', () => {
    const best = pickBestStaff(staff, { departmentId: 'dept-it', skillHint: 'plumbing' })
    expect(best?.userId).toBe('b')
  })

  it('returns null with no staff', () => {
    expect(pickBestStaff([], {})).toBeNull()
  })

  it('department match outranks no match at equal workload', () => {
    const a: AssignableStaff = { userId: 'x', name: 'X', departmentId: 'd1', skills: [], openCount: 2 }
    const b: AssignableStaff = { userId: 'y', name: 'Y', departmentId: 'd2', skills: [], openCount: 2 }
    expect(scoreStaff(a, { departmentId: 'd1' })).toBeGreaterThan(scoreStaff(b, { departmentId: 'd1' }))
  })
})
