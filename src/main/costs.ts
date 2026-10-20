import type { CostSummary } from '@shared/types'
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
    return { todayUsd, projectTodayUsd, projectTotalUsd: { ...this.store.get().totals } }
  }

  /** Returns a reason string if starting another run would break a daily limit, else null. */
  /**
   * `reservedUsd` / `reservedProjectUsd` are the worst-case spend of runs already in progress,
   * counted against the limit so parallel runs can't overshoot it.
   */
  budgetBlock(
    projectId: string,
    projectDailyUsd: number | null,
    globalDailyUsd: number | null,
    now = Date.now(),
    reservedUsd = 0,
    reservedProjectUsd = 0
  ): string | null {
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
