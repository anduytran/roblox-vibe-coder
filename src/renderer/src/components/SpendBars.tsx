import { useEffect, useMemo, useState } from 'react'
import type { CostDay } from '@shared/types'
import { useStore } from '../store'
import { usd } from './ui'

const DAYS = 14
const day = (ts: number): string => new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

/**
 * The last 14 days of estimated spend as plain CSS bars, newest on the right. For one game it is split by agent,
 * for all games by game; `name` turns a split key into what to show.
 */
export function SpendBars({ projectId, name }: { projectId?: string; name: (key: string) => string }) {
  const [days, setDays] = useState<CostDay[] | null>(null)
  // Spend changes whenever an agent finishes a run: fetch again then.
  const tick = useStore((s) => s.costs.todayUsd)
  useEffect(() => {
    let stale = false
    window.hangar.costs.history(DAYS, projectId).then(
      (d) => {
        if (!stale) setDays(d)
      },
      () => {
        if (!stale) setDays([])
      }
    )
    return () => {
      stale = true
    }
  }, [projectId, tick])

  const total = useMemo(() => (days ?? []).reduce((n, d) => n + d.usd, 0), [days])
  const split = useMemo(() => {
    const by = new Map<string, number>()
    for (const d of days ?? []) for (const [k, v] of Object.entries(d.by)) if (Number.isFinite(v)) by.set(k, (by.get(k) ?? 0) + v)
    return [...by].sort((a, b) => b[1] - a[1])
  }, [days])

  if (!days) return <div className="spend-chart spend-chart-loading" aria-hidden />
  if (!days.length) return null
  const max = Math.max(0, ...days.map((d) => d.usd))
  const top = (d: CostDay): string =>
    Object.entries(d.by)
      .filter(([, v]) => Number.isFinite(v))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `\n${name(k)}: ${usd(v)}`)
      .join('')
  return (
    <div className="spend-chart">
      <div className="spend-bars" role="img" aria-label={`Estimated spend over the last ${DAYS} days: ${usd(total)}`}>
        {days.map((d, i) => (
          <span key={d.start} className={`spend-bar ${i === days.length - 1 ? 'spend-today' : ''}`} title={`${day(d.start)}: ${usd(d.usd)}${top(d)}`}>
            <span style={{ height: max > 0 && d.usd > 0 ? `${Math.max(4, (d.usd / max) * 100)}%` : 0 }} />
          </span>
        ))}
      </div>
      <div className="spend-axis small muted">
        <span>{day(days[0]!.start)}</span>
        <span>{usd(total)} in 14 days (estimated)</span>
        <span>Today</span>
      </div>
      {split.length > 0 && (
        <p className="small muted spend-split">
          {split
            .slice(0, 5)
            .map(([k, v]) => `${name(k)} ${usd(v)}`)
            .join(' · ')}
          {split.length > 5 ? ' · …' : ''}
        </p>
      )}
    </div>
  )
}
