import { z } from 'zod'
import { createLogger } from '@/server/logger'
import { PRIORITIES, SENTIMENTS, type Priority } from '@/lib/types'

const log = createLogger('ai')

/**
 * AIService abstraction (spec §22/§25/§64):
 *   classifyComplaint()      — title/category/priority/department/sentiment/intent
 *   suggestResolution()      — staff-facing suggested fix
 *   findSimilarComplaints()  — duplicate/related detection
 *
 * Providers:
 *   - ZaiLLMProvider    — LLM via z-ai-web-dev-sdk (server-only) when available
 *   - RuleBasedProvider — deterministic keyword rules; also the validation
 *     fallback when the LLM returns garbage (spec §69: never fabricate output,
 *     never let AI block complaint creation)
 */

// ---------------------------------------------------------------------------
// Shared contracts
// ---------------------------------------------------------------------------

export interface ClassificationInput {
  text: string
  categories: string[]
  departments: string[]
  locations: string[]
}

export interface ClassificationResult {
  title: string
  category: string | null
  department: string | null
  location: string | null
  priority: Priority
  sentiment: string
  intent: string
  confidence: number
  provider: 'llm' | 'rules'
}

export interface SuggestionResult {
  suggestion: string
  confidence: number
  estimatedResolutionTime: string
}

const classificationSchema = z.object({
  title: z.string().min(3).max(200),
  category: z.string().nullable(),
  department: z.string().nullable(),
  location: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  sentiment: z.enum(SENTIMENTS),
  intent: z.string().max(120),
  confidence: z.number().min(0).max(1),
})

const suggestionSchema = z.object({
  suggestion: z.string().min(10).max(1200),
  confidence: z.number().min(0).max(1),
  estimatedResolutionTime: z.string().max(60),
})

// ---------------------------------------------------------------------------
// Rule-based provider (deterministic, always available)
// ---------------------------------------------------------------------------

const RULES: Array<{ keywords: string[]; category: string; department: string; priority: Priority }> = [
  { keywords: ['ac', 'air condition', 'heater', 'temperature', 'fan', 'hot', 'cold'], category: 'Maintenance', department: 'Facilities', priority: 'HIGH' },
  { keywords: ['wifi', 'internet', 'network', 'portal', 'login', 'password', 'system', 'software', 'computer', 'printer', 'email'], category: 'IT Support', department: 'IT', priority: 'MEDIUM' },
  { keywords: ['leak', 'water', 'pipe', 'flood', 'light', 'lighting', 'electric', 'power', 'elevator', 'lift', 'door', 'window', 'furniture', 'broken'], category: 'Facilities', department: 'Facilities', priority: 'HIGH' },
  { keywords: ['fee', 'receipt', 'payment', 'refund', 'billing', 'invoice', 'charges'], category: 'Finance', department: 'Finance', priority: 'MEDIUM' },
  { keywords: ['harassment', 'safety', 'theft', 'stolen', 'security', 'suspicious', 'fire'], category: 'Security', department: 'Security', priority: 'CRITICAL' },
  { keywords: ['clean', 'garbage', 'trash', 'sanitation', 'washroom', 'bathroom', 'toilet', 'hygiene'], category: 'Housekeeping', department: 'Facilities', priority: 'LOW' },
  { keywords: ['leave', 'salary', 'hr', 'id card', 'certificate', 'document request', 'admission', 'enrollment'], category: 'HR', department: 'Human Resources', priority: 'LOW' },
]

const URGENT_WORDS = ['urgent', 'immediately', 'emergency', 'danger', 'injur', 'fire', 'flood', 'unbearable', 'critical', 'asap', 'dangerous', 'extremely']
const NEGATIVE_WORDS = ['angry', 'frustrated', 'terrible', 'worst', 'unacceptable', 'disgusting', 'horrible', 'fed up', 'again and again', 'still not', 'not working', "isn't working", 'broken', 'no power', 'no water', 'out of order', 'extremely', 'unbearable', 'since morning', 'no response']
const POSITIVE_WORDS = ['thanks', 'thank you', 'appreciate', 'great', 'resolved']

export class RuleBasedProvider {
  readonly kind = 'rules' as const

  classifyComplaint(input: ClassificationInput): ClassificationResult {
    const text = input.text.toLowerCase()
    let best: { score: number; rule: (typeof RULES)[number] } | null = null
    for (const rule of RULES) {
      const score = rule.keywords.reduce((acc, kw) => (text.includes(kw) ? acc + 1 : acc), 0)
      if (score > 0 && (!best || score > best.score)) best = { score, rule }
    }

    const matchedCategory = best
      ? input.categories.find((c) => c.toLowerCase() === best!.rule.category.toLowerCase()) ?? best.rule.category
      : null
    const matchedDepartment = best
      ? input.departments.find((d) => d.toLowerCase() === best!.rule.department.toLowerCase()) ?? best.rule.department
      : null
    const matchedLocation = input.locations.find((loc) => text.includes(loc.toLowerCase())) ?? null

    let priority: Priority = best?.rule.priority ?? 'MEDIUM'
    if (URGENT_WORDS.some((w) => text.includes(w))) {
      priority = priority === 'LOW' ? 'MEDIUM' : priority === 'MEDIUM' ? 'HIGH' : 'CRITICAL'
    }

    const sentiment = NEGATIVE_WORDS.some((w) => text.includes(w))
      ? 'NEGATIVE'
      : POSITIVE_WORDS.some((w) => text.includes(w))
        ? 'POSITIVE'
        : 'NEUTRAL'

    // Title: first sentence, trimmed to ~80 chars
    const firstSentence = input.text.split(/[.!?\n]/)[0]?.trim() || input.text.slice(0, 80)
    const title = firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}...` : firstSentence

    const intent = best ? `${best.rule.category.toLowerCase()} issue` : 'general complaint'

    return {
      title,
      category: matchedCategory,
      department: matchedDepartment,
      location: matchedLocation,
      priority,
      sentiment,
      intent,
      confidence: best ? Math.min(0.9, 0.55 + best.score * 0.1) : 0.35,
      provider: 'rules',
    }
  }

  suggestResolution(input: { text: string; category: string | null; department: string | null }): SuggestionResult {
    const text = input.text.toLowerCase()
    let guidance =
      'Review the complaint details, contact the customer for any missing information, inspect the reported issue on site, and update the ticket status as you progress.'
    let estimate = '4 hours'

    if (/ac|air condition|heater|temperature|fan/.test(text)) {
      guidance = 'Check the thermostat settings and circuit breaker first. If power is fine, dispatch a maintenance technician to inspect the HVAC unit, filters, and refrigerant levels. Offer a temporary fan/heater if the fix may take longer than 2 hours.'
      estimate = '2 hours'
    } else if (/wifi|internet|network|portal|login|password/.test(text)) {
      guidance = 'Verify service status on the network dashboard. Restart the access point or reset the affected account credentials. If the outage affects multiple users, check for a wider ISP/infrastructure issue and post updates to affected tickets.'
      estimate = '1 hour'
    } else if (/leak|water|pipe|flood/.test(text)) {
      guidance = 'Shut off the nearest water valve to contain the leak, place warning signage, and dispatch the plumbing team. Document the area with photos and schedule drying/cleanup to prevent damage.'
      estimate = '90 minutes'
    } else if (/light|electric|power|elevator|lift/.test(text)) {
      guidance = 'Inspect the electrical panel for tripped breakers. For elevators, ensure no one is trapped, then engage the licensed maintenance vendor. Use barricades/signage for safety until repaired.'
      estimate = '3 hours'
    } else if (/fee|receipt|payment|refund|billing/.test(text)) {
      guidance = 'Pull up the customer transaction history, verify the reported discrepancy against finance records, and issue the correction or receipt. Communicate the exact timeline back to the customer.'
      estimate = '1 business day'
    } else if (/clean|garbage|trash|washroom|toilet|sanitation/.test(text)) {
      guidance = 'Schedule the housekeeping team for immediate cleaning, restock consumables, and add the location to the routine inspection checklist to prevent recurrence.'
      estimate = '2 hours'
    }

    void input
    return {
      suggestion: guidance,
      confidence: 0.62,
      estimatedResolutionTime: estimate,
    }
  }
}

// ---------------------------------------------------------------------------
// LLM provider via z-ai-web-dev-sdk (server-only, gracefully unavailable)
// ---------------------------------------------------------------------------

export class ZaiLLMProvider {
  readonly kind = 'llm' as const

  private async getClient(): Promise<import('z-ai-web-dev-sdk').default | null> {
    try {
      const { default: ZAI } = await import('z-ai-web-dev-sdk')
      return await ZAI.create()
    } catch (error) {
      log.debug('ai.client_unavailable', {
        message: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  async classifyComplaint(input: ClassificationInput): Promise<ClassificationResult | null> {
    const client = await this.getClient()
    if (!client) return null
    try {
      const completion = await client.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'You are a complaint-triage engine for SmartServe. Analyze the customer complaint and respond with ONLY a JSON object with keys: title (short summary, max 80 chars), category (one of the provided categories or null), department (one of the provided departments or null), location (extracted location or null), priority (LOW|MEDIUM|HIGH|CRITICAL), sentiment (POSITIVE|NEUTRAL|NEGATIVE), intent (short phrase), confidence (0-1). No markdown, no commentary.',
          },
          {
            role: 'user',
            content: `Complaint:\n"""\n${input.text.slice(0, 2000)}\n"""\n\nValid categories: ${input.categories.join(', ') || 'none configured'}\nValid departments: ${input.departments.join(', ') || 'none configured'}\nKnown locations: ${input.locations.join(', ') || 'none'}`,
          },
        ],
        thinking: { type: 'disabled' },
      })
      const content = completion.choices[0]?.message?.content
      if (!content) return null
      const jsonText = content.replace(/```json|```/g, '').trim()
      const parsed = classificationSchema.safeParse(JSON.parse(jsonText))
      if (!parsed.success) {
        log.warn('ai.classify.invalid_output')
        return null
      }
      // Normalize category/department against org lists
      const norm = (v: string | null, list: string[]) =>
        v ? list.find((item) => item.toLowerCase() === v.toLowerCase()) ?? v : null
      return {
        ...parsed.data,
        category: norm(parsed.data.category, input.categories),
        department: norm(parsed.data.department, input.departments),
        location: norm(parsed.data.location, input.locations),
        provider: 'llm',
      }
    } catch (error) {
      log.warn('ai.classify.failed', { message: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  async suggestResolution(input: { text: string; category: string | null; department: string | null }): Promise<SuggestionResult | null> {
    const client = await this.getClient()
    if (!client) return null
    try {
      const completion = await client.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'You are a support-expert assistant for SmartServe. Given a complaint, produce a concise, actionable resolution plan for staff. Respond with ONLY JSON: { "suggestion": string (2-4 sentences, concrete steps), "confidence": number 0-1, "estimatedResolutionTime": string like "2 hours" }. No markdown.',
          },
          {
            role: 'user',
            content: `Complaint: ${input.text.slice(0, 2000)}\nCategory: ${input.category ?? 'unknown'}\nDepartment: ${input.department ?? 'unknown'}`,
          },
        ],
        thinking: { type: 'disabled' },
      })
      const content = completion.choices[0]?.message?.content
      if (!content) return null
      const parsed = suggestionSchema.safeParse(JSON.parse(content.replace(/```json|```/g, '').trim()))
      return parsed.success ? parsed.data : null
    } catch (error) {
      log.warn('ai.suggest.failed', { message: error instanceof Error ? error.message : String(error) })
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Facade — LLM first, rules fallback; failures never throw (spec §23/§69)
// ---------------------------------------------------------------------------

const ruleProvider = new RuleBasedProvider()
const llmProvider = new ZaiLLMProvider()

export async function classifyComplaint(input: ClassificationInput): Promise<ClassificationResult> {
  const llm = await llmProvider.classifyComplaint(input)
  if (llm) return llm
  return ruleProvider.classifyComplaint(input)
}

export async function suggestResolution(input: { text: string; category: string | null; department: string | null }): Promise<SuggestionResult> {
  const llm = await llmProvider.suggestResolution(input)
  if (llm) return llm
  return ruleProvider.suggestResolution(input)
}

export { ruleProvider }
