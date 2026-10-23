import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AppSettings } from '../src/shared/types'
import { CostTracker, planLimitsFor } from '../src/main/costs'

const tracker = () => new CostTracker(join(mkdtempSync(join(tmpdir(), 'hangar-plan-')), 'costs.json'))
const LIMITS = { fiveHourPct: 90, weeklyPct: 80 }
const HOUR = 3600 * 1000

test('plan usage: fractions or percents, seconds or ms; windows reset to zero after their reset time', () => {
  const c = tracker()
  const now = 1_800_000_000_000
  assert.equal(c.planUsage(now), null)
  assert.equal(c.recordPlan({ rateLimitType: 'five_hour', utilization: 0.34, resetsAt: (now + 2 * HOUR) / 1000, status: 'allowed' }, now), true)
  assert.equal(c.recordPlan({ rateLimitType: 'seven_day', utilization: 12, resetsAt: now + 50 * HOUR, status: 'allowed' }, now), true)
  assert.equal(c.recordPlan({ rateLimitType: 'seven_day', utilization: 12, resetsAt: now + 50 * HOUR, status: 'allowed' }, now), false, 'unchanged reports are ignored')
  assert.equal(c.recordPlan({ rateLimitType: 'bogus', utilization: 1 }, now), false)
  const p = c.planUsage(now)!
  assert.deepEqual([p.fiveHour?.usedPct, p.fiveHour?.resetsAt, p.weekly?.usedPct], [34, now + 2 * HOUR, 12])
  assert.equal(c.planUsage(now + 3 * HOUR)!.fiveHour?.usedPct, 0)
  assert.equal(c.summary(now).plan?.weekly?.usedPct, 12)
})

test('plan limits replace the dollar limits in Claude Max mode', () => {
  const c = tracker()
  const now = 1_800_000_000_000
  c.record('p', 'main', 50, now)
  assert.match(c.budgetBlock('p', null, 20, now) ?? '', /Daily spending limit/)
  assert.equal(c.budgetBlock('p', null, 20, now, 0, 0, LIMITS), null, 'no dollar limit on Max, and no usage known yet')

  c.recordPlan({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: now + HOUR, status: 'allowed' }, now)
  c.recordPlan({ rateLimitType: 'seven_day', utilization: 0.81, resetsAt: now + 50 * HOUR, status: 'allowed' }, now)
  assert.match(c.budgetBlock('p', null, null, now, 0, 0, LIMITS) ?? '', /Weekly plan limit reached: 81%.*limit is 80%/)
  assert.equal(c.budgetBlock('p', null, null, now, 0, 0, { fiveHourPct: 90, weeklyPct: 95 }), null)
  c.recordPlan({ rateLimitType: 'five_hour', utilization: 0.93, resetsAt: now + HOUR, status: 'allowed_warning' }, now)
  assert.match(c.budgetBlock('p', null, null, now, 0, 0, LIMITS) ?? '', /5-hour plan limit reached: 93%/)

  // The plan refusing requests blocks whatever the limits say, until it resets.
  c.recordPlan({ rateLimitType: 'seven_day_opus', utilization: 1, resetsAt: now + 2 * HOUR, status: 'rejected' }, now)
  assert.match(c.budgetBlock('p', null, null, now, 0, 0, { fiveHourPct: 100, weeklyPct: 100 }) ?? '', /weekly Opus limit is reached/)
  assert.equal(c.planUsage(now + 3 * HOUR)!.blocked, null)

  const base = { authMode: 'apiKey', planLimits: LIMITS } as AppSettings
  assert.equal(planLimitsFor(base), null)
  assert.deepEqual(planLimitsFor({ ...base, authMode: 'max' }), LIMITS)
})

test('plan usage reports are read from the engine stream and passed through untouched', async () => {
  const c = tracker()
  const seen: unknown[] = []
  const changes: unknown[] = []
  const event = { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.2, status: 'allowed' } }
  async function* engine() {
    yield { type: 'assistant' }
    yield event
    yield event
  }
  for await (const m of c.watch(engine(), (i) => changes.push(i))) seen.push(m)
  assert.equal(seen.length, 3)
  assert.equal(changes.length, 1)
  assert.equal(c.planUsage()!.fiveHour?.usedPct, 20)
})

test("the plan's own usage answer is recorded exactly (0.5 means half a percent here)", () => {
  const c = tracker()
  const now = Date.parse('2026-10-22T20:00:00Z')
  assert.equal(c.recordPlanAnswer({ five_hour: { utilization: 0.5, resets_at: '2026-10-22T22:00:00Z' }, seven_day: { utilization: 15, resets_at: '2026-10-27T09:00:00Z' } }, now), true)
  const p = c.planUsage(now)!
  assert.deepEqual([p.fiveHour?.usedPct, p.weekly?.usedPct, p.weekly?.resetsAt], [1, 15, Date.parse('2026-10-27T09:00:00Z')])
  assert.equal(c.recordPlanAnswer({ seven_day: { utilization: null, resets_at: null } }, now), false)
})

test('usage probe: asks the engine without sending a prompt, and stops it afterwards', async () => {
  const { probePlanUsage } = await import('../src/main/planUsageProbe')
  let sawPrompt = false
  let aborted = false
  const query = (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const ac = args.options.abortController as AbortController
    ac.signal.addEventListener('abort', () => (aborted = true))
    void (async () => {
      for await (const _ of args.prompt) sawPrompt = true
    })()
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 15, resets_at: null } } })
    }
  }
  const ok = await probePlanUsage(query, {})
  assert.equal(ok.answer?.rate_limits?.seven_day?.utilization, 15)
  assert.equal(sawPrompt, false)
  assert.equal(aborted, true)
  const none = await probePlanUsage(() => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: false, rate_limits: null }) }), {})
  assert.match(none.reason ?? '', /not available/)
  assert.match((await probePlanUsage(() => ({}), {})).reason ?? '', /no usage method/)
})

test('recording a cost keeps plan usage; a report without a percentage keeps the last one', () => {
  const c = tracker()
  const now = Date.parse('2026-10-22T20:00:00Z')
  c.recordPlanAnswer({ five_hour: { utilization: 40, resets_at: '2026-10-22T22:00:00Z' } }, now)
  c.record('hangar:ideas', 'ideas', 0.07, now)
  assert.equal(c.planUsage(now)!.fiveHour?.usedPct, 40)
  c.recordPlan({ rateLimitType: 'five_hour', resetsAt: Date.parse('2026-10-22T22:00:00Z') / 1000, status: 'allowed' }, now)
  assert.equal(c.planUsage(now)!.fiveHour?.usedPct, 40)
})
