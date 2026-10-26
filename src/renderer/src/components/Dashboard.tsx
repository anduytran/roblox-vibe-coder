import { useEffect, useMemo } from 'react'
import type { AutopilotState, Project } from '@shared/types'
import { attempt, ensureTrendsFresh, openPage, openProjectAt, openWizard, selectProject, setAutopilot, useStore, type ProjectTab } from '../store'
import { FirstRun } from './FirstRun'
import { SpendBars } from './SpendBars'
import { Avatar, Button, Icon, planLine, timeAgo, usd } from './ui'
import { firstLine, useWaiting } from './waiting'
import { revealHidden } from '@shared/text'

export const AUTOPILOT_LABEL: Record<AutopilotState['status'], string> = {
  off: 'Autopilot off',
  running: 'Building',
  waiting: 'Needs your review',
  checkin: 'Check-in ready',
  paused: 'Paused'
}

const WEEK_MS = 7 * 24 * 3600 * 1000

interface Need {
  key: string
  project: Project
  text: string
  detail?: string
  tone: 'amber' | 'live' | 'err'
  action: string
  go: () => void
}

/** Home: what needs you, how each game is doing, and this week at a glance. Ideas live on their own page. */
export function Dashboard() {
  const projects = useStore((s) => s.projects)
  const autopilot = useStore((s) => s.autopilot)
  const reviews = useStore((s) => s.reviews)
  const costs = useStore((s) => s.costs)
  const onMax = useStore((s) => s.settings?.authMode === 'max')
  const trends = useStore((s) => s.trends)
  const waiting = useWaiting()

  useEffect(() => {
    ensureTrendsFresh()
  }, [])

  const needs = useMemo(() => {
    const items: Need[] = []
    for (const p of projects) {
      const ap = autopilot[p.id]
      if (ap?.status === 'checkin') {
        const report = ap.reports[ap.reports.length - 1]
        items.push({ key: `${p.id}:checkin`, project: p, text: `Sprint ${ap.sprint} check-in is ready`, detail: report ? firstLine(report.text) : undefined, tone: 'live', action: 'Answer', go: () => openProjectAt(p.id, 'overview') })
      } else if (ap?.status === 'waiting') {
        const reviewId = ap.awaitingReviewId ?? undefined
        items.push({ key: `${p.id}:ap`, project: p, text: ap.reason ?? 'A task needs your review', tone: 'amber', action: 'Review', go: () => openProjectAt(p.id, reviewId ? 'reviews' : 'overview', { reviewId }) })
      } else if (ap?.status === 'paused' && ap.reason && !/by you/i.test(ap.reason)) {
        items.push({ key: `${p.id}:ap`, project: p, text: 'Autopilot paused', detail: ap.reason, tone: 'amber', action: 'Open', go: () => openProjectAt(p.id, 'overview') })
      }
      // Approvals, one row per agent that's waiting.
      const byAgent = new Map<string, typeof waiting.approvals>()
      for (const a of waiting.approvals.filter((x) => x.request.projectId === p.id)) byAgent.set(a.request.agentId, [...(byAgent.get(a.request.agentId) ?? []), a])
      for (const [agentId, list] of byAgent) {
        const risky = list.some((a) => a.request.dangerous)
        items.push({
          key: `${p.id}:approve:${agentId}`,
          project: p,
          text: `${list[0]!.agent} needs approval${list.length > 1 ? ` (${list.length})` : ''}`,
          detail: firstLine(list[0]!.request.summary),
          tone: risky ? 'err' : 'amber',
          action: 'Approve',
          go: () => openProjectAt(p.id, 'agents', { agentId })
        })
      }
      // Reviews, except the one autopilot is already waiting on (shown above).
      for (const r of waiting.reviews.filter((x) => x.project.id === p.id && x.review.id !== (ap?.status === 'waiting' ? ap.awaitingReviewId : null))) {
        items.push({
          key: `${p.id}:review:${r.review.id}`,
          project: p,
          text: `Review: ${revealHidden(r.review.title)}`,
          detail: `${r.agent} · ${r.review.kind === 'research' ? 'web research' : `${r.review.files.length} file${r.review.files.length === 1 ? '' : 's'}`} · ${timeAgo(r.review.createdAt)}`,
          tone: 'amber',
          action: 'Review',
          go: () => openProjectAt(p.id, 'reviews', { reviewId: r.review.id })
        })
      }
    }
    return items
  }, [projects, autopilot, waiting])

  const week = useMemo(() => {
    const since = Date.now() - WEEK_MS
    let merged = 0
    for (const list of Object.values(reviews)) for (const r of list) if (r.status === 'merged' && r.kind !== 'research' && (r.decidedAt ?? 0) >= since) merged++
    let checkins = 0
    for (const ap of Object.values(autopilot)) for (const rep of ap.reports) if (rep.at >= since) checkins++
    return { merged, checkins }
  }, [reviews, autopilot])

  const topSpace = trends?.genres.filter((g) => g.saturation < 25).sort((a, b) => b.score - a.score)[0]

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h1>Home</h1>
          <p className="muted">
            {waiting.count ? `${waiting.count} thing${waiting.count === 1 ? '' : 's'} waiting for you` : 'Nothing waiting for you'} · {projects.length} game
            {projects.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button tone="primary" onClick={() => openWizard()}>
          <Icon name="plus" />
          New game
        </Button>
      </header>

      {needs.length > 0 && (
        <section className="home-section">
          <h2>Needs you</h2>
          <div className="needs-list">
            {needs.map((n) => (
              <button key={n.key} className={`needs-item needs-${n.tone}`} onClick={n.go}>
                <Avatar name={n.project.name} />
                <span className="needs-text">
                  <strong>
                    {n.project.name} · {n.text}
                  </strong>
                  {n.detail && <span>{n.detail}</span>}
                </span>
                <span className="needs-action">{n.action}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {projects.length === 0 ? (
        <FirstRun />
      ) : (
        <section className="home-section">
          <h2>Your games</h2>
          <div className="game-grid">
            {projects.map((p) => (
              <GameCard key={p.id} project={p} ap={autopilot[p.id]} spent={costs.projectTotalUsd[p.id] ?? 0} />
            ))}
          </div>
        </section>
      )}

      <section className="home-section home-pair">
        <div className="card week-card">
          <h3>This week</h3>
          <div className="week-stats">
            {onMax ? (
              <div title={planLine(costs.plan)}>
                <strong>{costs.plan?.blocked ? 'Limit hit' : costs.plan?.weekly ? `${costs.plan.weekly.usedPct}%` : costs.plan?.fiveHour ? `${costs.plan.fiveHour.usedPct}%` : '—'}</strong>
                <span className="muted small">{costs.plan?.weekly ? 'of your weekly Claude plan' : costs.plan?.fiveHour ? 'of your 5-hour Claude plan' : 'Claude plan usage (after first run)'}</span>
              </div>
            ) : (
              <div>
                <strong>{usd(costs.weekUsd)}</strong>
                <span className="muted small">spent (estimated)</span>
              </div>
            )}
            <div>
              <strong>{week.merged}</strong>
              <span className="muted small">task{week.merged === 1 ? '' : 's'} merged</span>
            </div>
            <div>
              <strong>{week.checkins}</strong>
              <span className="muted small">check-in{week.checkins === 1 ? '' : 's'}</span>
            </div>
            <div>
              <strong>{waiting.reviews.length}</strong>
              <span className="muted small">waiting for review</span>
            </div>
          </div>
          {projects.length > 0 && <SpendBars name={(id) => (id === 'hangar:ideas' ? 'Ideas' : (projects.find((p) => p.id === id)?.name ?? 'A removed game'))} />}
        </div>
        <button className="card ideas-teaser" onClick={() => openPage('ideas')}>
          <span className="row gap-sm">
            <Icon name="bulb" />
            <strong>Ideas</strong>
          </span>
          <span className="muted small">
            {trends?.saved.length ? `${trends.saved.length} saved idea${trends.saved.length === 1 ? '' : 's'}` : 'No saved ideas yet'}
            {topSpace ? ` · Top open space: ${topSpace.genre}` : ''}
          </span>
          <span className="needs-action">Open Ideas</span>
        </button>
      </section>
    </div>
  )
}

function GameCard({ project, ap, spent }: { project: Project; ap: AutopilotState | undefined; spent: number }) {
  const status = ap?.status ?? 'off'
  const report = ap?.reports[ap.reports.length - 1]
  const pending = useStore((s) => (s.reviews[project.id] ?? []).filter((r) => r.status === 'pending').length)
  // Last time anything happened: an agent's newest log entry, a review, or autopilot.
  const lastActive = useStore((s) => {
    let t = ap?.updatedAt ?? 0
    for (const a of Object.values(s.agents[project.id] ?? {})) t = Math.max(t, a.log[a.log.length - 1]?.ts ?? 0)
    t = Math.max(t, s.reviews[project.id]?.[0]?.createdAt ?? 0)
    return t
  })
  const go = (tab: ProjectTab): void => openProjectAt(project.id, tab)
  const resume = (): void => void attempt(async () => setAutopilot(await window.hangar.autopilot.resume(project.id)))

  return (
    <article className="game-card">
      <button className="game-card-main" onClick={() => selectProject(project.id)}>
        <div className="row gap-sm">
          <Avatar name={project.name} />
          <strong className="game-card-name">{project.name}</strong>
          <span className={`ap-pill ap-${status}`}>{AUTOPILOT_LABEL[status]}</span>
        </div>
        {ap && ap.status !== 'off' && (
          <div className="sprint-meter" aria-label={`Sprint ${ap.sprint}: ${ap.tasksDone} of ${ap.config.sprintTasks} tasks`}>
            {Array.from({ length: ap.config.sprintTasks }, (_, i) => (
              <span key={i} className={i < ap.tasksDone ? 'done' : i === ap.tasksDone && status === 'running' ? 'now' : ''} />
            ))}
          </div>
        )}
        <span className="muted small">
          {ap && ap.status !== 'off' ? `Sprint ${ap.sprint} · ${ap.tasksDone}/${ap.config.sprintTasks} tasks · ` : ''}
          {usd(spent)} total{lastActive ? ` · active ${timeAgo(lastActive)}` : ''}
        </span>
        {report && <span className="small game-card-report">Last check-in: {firstLine(report.text)}</span>}
      </button>
      <div className="row gap-xs game-card-actions">
        {status === 'checkin' && (
          <Button size="sm" tone="primary" onClick={() => go('overview')}>
            Answer check-in
          </Button>
        )}
        {status === 'paused' && (
          <Button size="sm" tone="primary" onClick={resume}>
            Resume
          </Button>
        )}
        {status === 'off' && (
          <Button size="sm" onClick={() => go('overview')}>
            Start autopilot
          </Button>
        )}
        {pending > 0 && (
          <Button size="sm" onClick={() => go('reviews')}>
            Reviews ({pending})
          </Button>
        )}
        <span className="spacer" />
        <Button size="sm" tone="ghost" onClick={() => selectProject(project.id)}>
          Open
        </Button>
      </div>
    </article>
  )
}
