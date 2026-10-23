import type { AppSettings, CostSummary, PlanUsage, PlanUsageWindow } from '@shared/types'
import { JsonStore } from './jsonStore'

interface CostEntry {
  ts: number
  projectId: string
  agentId: string
  usd: number
}

interface Ledger {
  entries: CostEntry[]
  /** Lifetime totals per project (entries older than 60 days are pruned but still counted here). */
  totals: Record<string, number>
  /** Claude plan usage per window type, as the engine last reported it (absent in older files). */
  plan?: Record<string, { usedPct: number | null; resetsAt: number | null; status: string; at: number }>
}

/** What the engine reports in its `rate_limit_event` messages (Claude subscription sign-in only). */
export interface RateLimitInfo {
  status?: string
  resetsAt?: number
  rateLimitType?: string
  utilization?: number
}

export const DEFAULT_PLAN_LIMITS: AppSettings['planLimits'] = { fiveHourPct: 90, weeklyPct: 80 }

/** The plan limits to enforce, or null when the dollar limits apply (API key). */
export function planLimitsFor(settings: AppSettings): AppSettings['planLimits'] | null {
  return settings.authMode === 'max' ? (settings.planLimits ?? DEFAULT_PLAN_LIMITS) : null
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'extra usage'
}

function clock(ts: number | null, now: number): string {
  if (ts === null) return 'later'
  const d = new Date(ts)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return ts - now < 20 * 3600 * 1000 ? `at ${time}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function startOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const KEEP_MS = 60 * 24 * 60 * 60 * 1000

export class CostTracker {
  private store: JsonStore<Ledger>

  constructor(file: string) {
    this.store = new JsonStore<Ledger>(file, { entries: [], totals: {} })
  }

  record(projectId: string, agentId: string, usd: number, now = Date.now()): void {
    if (!Number.isFinite(usd) || usd <= 0) return
    this.store.update((l) => ({
      ...l,
      entries: [...l.entries.filter((e) => now - e.ts < KEEP_MS), { ts: now, projectId, agentId, usd }],
      totals: { ...l.totals, [projectId]: (l.totals[projectId] ?? 0) + usd }
    }))
  }

  summary(now = Date.now()): CostSummary {
    const since = startOfLocalDay(now)
    const projectTodayUsd: Record<string, number> = {}
    let todayUsd = 0
    for (const e of this.store.get().entries) {
      if (e.ts < since) continue
      todayUsd += e.usd
      projectTodayUsd[e.projectId] = (projectTodayUsd[e.projectId] ?? 0) + e.usd
    }
    return { todayUsd, projectTodayUsd, projectTotalUsd: { ...this.store.get().totals }, plan: this.planUsage(now) }
  }

  /**
   * Record a plan usage report from the engine. Returns true if anything changed.
   * Utilization may arrive as a fraction (0–1) or a percentage; reset times as seconds or milliseconds.
   */
  recordPlan(info: RateLimitInfo, now = Date.now()): boolean {
    const type = typeof info.rateLimitType === 'string' && info.rateLimitType in WINDOW_LABEL ? info.rateLimitType : null
    if (!type) return false
    const u = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : null
    const usedPct = u === null ? null : Math.max(0, Math.min(100, u <= 1 ? u * 100 : u))
    const r = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : null
    const resetsAt = r === null ? null : r < 1e12 ? r * 1000 : r
    return this.setPlanWindow(type, usedPct, resetsAt, typeof info.status === 'string' ? info.status : 'allowed', now)
  }

  /**
   * Record the plan's own usage answer (the numbers behind Claude Code's /usage): exact percentages and
   * ISO reset times. Returns true if anything changed.
   */
  recordPlanAnswer(limits: Partial<Record<'five_hour' | 'seven_day', { utilization: number | null; resets_at: string | null } | null>>, now = Date.now()): boolean {
    let changed = false
    for (const type of ['five_hour', 'seven_day'] as const) {
      const w = limits[type]
      if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue
      const t = w.resets_at ? Date.parse(w.resets_at) : NaN
      const prevStatus = this.store.get().plan?.[type]?.status
      // A refusal the engine reported stays until its window resets; otherwise this answer is current.
      const status = prevStatus === 'rejected' && w.utilization >= 100 ? 'rejected' : 'allowed'
      changed = this.setPlanWindow(type, Math.max(0, Math.min(100, w.utilization)), Number.isFinite(t) ? t : null, status, now) || changed
    }
    return changed
  }

  private setPlanWindow(type: string, usedPct: number | null, resetsAt: number | null, status: string, now: number): boolean {
    const prev = this.store.get().plan?.[type]
    // Runs often report only a window's status and reset time; keep the last known percentage for the same window.
    const keep = usedPct === null && prev && prev.usedPct !== null && (prev.resetsAt === resetsAt || resetsAt === null)
    const entry = { usedPct: keep ? prev.usedPct : usedPct, resetsAt, status, at: now }
    if (prev && prev.usedPct === entry.usedPct && prev.resetsAt === entry.resetsAt && prev.status === entry.status) return false
    this.store.update((l) => ({ ...l, plan: { ...(l.plan ?? {}), [type]: entry } }))
    return true
  }

  planUsage(now = Date.now()): PlanUsage | null {
    const plan = this.store.get().plan
    if (!plan || !Object.keys(plan).length) return null
    const live = (type: string): PlanUsageWindow | null => {
      const e = plan[type]
      if (!e) return null
      // Once its reset time has passed, the window starts again from zero.
      if (e.resetsAt !== null && e.resetsAt <= now) return { usedPct: 0, resetsAt: null, at: e.at }
      return e.usedPct === null ? null : { usedPct: Math.round(e.usedPct), resetsAt: e.resetsAt, at: e.at }
    }
    let blocked: PlanUsage['blocked'] = null
    for (const [type, e] of Object.entries(plan)) {
      if (e.status !== 'rejected') continue
      // Without a reset time, trust a refusal for 5 hours at most.
      const until = e.resetsAt ?? e.at + 5 * 3600 * 1000
      if (until > now) blocked = { window: WINDOW_LABEL[type] ?? type, until: e.resetsAt }
    }
    return { fiveHour: live('five_hour'), weekly: live('seven_day'), blocked }
  }

  /** In Claude Max mode: a reason not to start new work because the plan is at its limits, else null. */
  planBlock(limits: AppSettings['planLimits'], now = Date.now()): string | null {
    const p = this.planUsage(now)
    if (!p) return null
    if (p.blocked) return `Your Claude plan's ${p.blocked.window} limit is reached. It resets ${clock(p.blocked.until, now)}.`
    if (p.fiveHour && p.fiveHour.usedPct >= limits.fiveHourPct) {
      return `5-hour plan limit reached: ${p.fiveHour.usedPct}% used (your limit is ${limits.fiveHourPct}%). It resets ${clock(p.fiveHour.resetsAt, now)}, or raise the limit in Settings.`
    }
    if (p.weekly && p.weekly.usedPct >= limits.weeklyPct) {
      return `Weekly plan limit reached: ${p.weekly.usedPct}% used (your limit is ${limits.weeklyPct}%). It resets ${clock(p.weekly.resetsAt, now)}, or raise the limit in Settings.`
    }
    return null
  }

  /** Pass engine messages through, recording plan usage reports; `onChange` runs when usage changed. */
  async *watch(messages: AsyncIterable<unknown>, onChange: (info: RateLimitInfo) => void): AsyncGenerator<unknown> {
    for await (const m of messages) {
      const info = (m as { type?: string; rate_limit_info?: RateLimitInfo } | null)?.type === 'rate_limit_event' ? (m as { rate_limit_info?: RateLimitInfo }).rate_limit_info : undefined
      if (info && typeof info === 'object' && this.recordPlan(info)) onChange(info)
      yield m
    }
  }

  /**
   * Returns a reason string if starting another run would break a limit, else null.
   * With `plan` limits (Claude Max mode) the plan's 5-hour and weekly usage are the limits; otherwise the
   * daily dollar limits apply. `reservedUsd` / `reservedProjectUsd` are the worst-case spend of runs
   * already in progress, counted against the limit so parallel runs can't overshoot it.
   */
  budgetBlock(
    projectId: string,
    projectDailyUsd: number | null,
    globalDailyUsd: number | null,
    now = Date.now(),
    reservedUsd = 0,
    reservedProjectUsd = 0,
    plan: AppSettings['planLimits'] | null = null
  ): string | null {
    if (plan) return this.planBlock(plan, now)
    const s = this.summary(now)
    if (globalDailyUsd !== null && s.todayUsd + reservedUsd >= globalDailyUsd) {
      const running = reservedUsd > 0 ? ` including the most that running agents could still spend` : ''
      return `Daily spending limit reached ($${s.todayUsd.toFixed(2)} spent of $${globalDailyUsd.toFixed(2)}${running}). Wait for running agents or raise the limit in Settings.`
    }
    const p = (s.projectTodayUsd[projectId] ?? 0) + reservedProjectUsd
    if (projectDailyUsd !== null && p >= projectDailyUsd) {
      return `This project's daily limit is reached ($${p.toFixed(2)} of $${projectDailyUsd.toFixed(2)}).`
    }
    return null
  }
}
