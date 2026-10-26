import { addProject, attempt, openPage, openSettings, openWizard, selectProject, setInboxOpen, toast, useStore } from '../store'
import { useState } from 'react'
import { modKey } from './Shortcuts'
import { CloneDialog } from './CloneDialog'
import { useWaiting } from './waiting'
import type { AppSettings, PlanUsage } from '@shared/types'
import { Avatar, Icon, resetsText, usd } from './ui'

export function Sidebar({ onOpenShortcuts }: { onOpenShortcuts: () => void }) {
  const projects = useStore((s) => s.projects)
  const selected = useStore((s) => s.selectedProjectId)
  const page = useStore((s) => s.page)
  const inboxOpen = useStore((s) => s.inboxOpen)
  const waiting = useWaiting()
  const agents = useStore((s) => s.agents)
  const approvals = useStore((s) => s.approvals)
  const costs = useStore((s) => s.costs)
  const settings = useStore((s) => s.settings)
  const autopilot = useStore((s) => s.autopilot)
  const [cloning, setCloning] = useState(false)

  const anyRunning = Object.values(agents).some((proj) =>
    Object.values(proj).some((a) => a.status === 'working' || a.status === 'awaiting_approval' || a.status === 'queued')
  )
  const limit = settings?.globalDailyBudgetUsd ?? null

  return (
    <aside className="sidebar">
      <div className="brand">
        <svg className="brand-mark" width="20" height="20" viewBox="0 0 20 20" aria-hidden>
          <path d="M2 16 10 4l8 12h-4.2L10 10.2 6.2 16Z" fill="currentColor" />
        </svg>
        Hangar
      </div>
      <button className={`side-btn side-nav ${selected === null && page === 'home' ? 'side-btn-active' : ''}`} aria-current={selected === null && page === 'home' ? 'page' : undefined} onClick={() => selectProject(null)}>
        <Icon name="home" />
        Home
      </button>
      <button className={`side-btn side-nav ${selected === null && page === 'ideas' ? 'side-btn-active' : ''}`} aria-current={selected === null && page === 'ideas' ? 'page' : undefined} onClick={() => openPage('ideas')}>
        <Icon name="bulb" />
        Ideas
      </button>
      <button className={`side-btn side-nav ${inboxOpen ? 'side-btn-active' : ''}`} aria-pressed={inboxOpen} title="Everything waiting for you (Cmd/Ctrl+I)" onClick={() => setInboxOpen(!inboxOpen)}>
        <Icon name="bell" />
        Inbox
        {waiting.count > 0 && <span className="badge badge-warn side-count">{waiting.count}</span>}
      </button>
      <button className="side-btn side-new" onClick={() => openWizard()}>
        <Icon name="plus" />
        New game
      </button>
      <div className="side-label side-label-gap">Games</div>
      <ul className="project-list">
        {projects.map((p) => {
          const list = Object.values(agents[p.id] ?? {})
          const working = list.filter((a) => a.status === 'working').length || (autopilot[p.id]?.status === 'running' ? 1 : 0)
          const ap = autopilot[p.id]
          const waiting = approvals.filter((a) => a.projectId === p.id).length + (ap?.status === 'waiting' || ap?.status === 'checkin' ? 1 : 0)
          const errored = list.some((a) => a.status === 'error')
          return (
            <li key={p.id}>
              <button className={`project-item ${selected === p.id ? 'project-item-active' : ''}`} onClick={() => selectProject(p.id)}>
                <span className="avatar-wrap">
                  <Avatar name={p.name} />
                  {(waiting > 0 || working > 0 || errored) && <span className={`dot avatar-dot ${waiting ? 'dot-warn' : working ? 'dot-live' : 'dot-err'}`} />}
                </span>
                <span className="project-item-name">{p.name}</span>
                {waiting > 0 ? (
                  <span className="badge badge-warn" title="Waiting for you (approvals, reviews or a check-in)">
                    {waiting}
                  </span>
                ) : working > 0 ? (
                  <span className="badge" title="Agents working">
                    {working}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
      <button className="side-btn side-btn-quiet" onClick={() => void addProject()}>
        <Icon name="folder" />
        Open existing folder
      </button>
      <button className="side-btn side-btn-quiet" onClick={() => setCloning(true)}>
        <Icon name="changes" />
        Clone from GitHub
      </button>
      {cloning && <CloneDialog onClose={() => setCloning(false)} />}

      <div className="side-foot">
        {settings?.authMode === 'max' ? (
          <PlanMeters plan={costs.plan} limits={settings.planLimits} />
        ) : (
          <>
            <div className="spend" title="Spent today across all projects">
              <span>Today</span>
              <strong>
                {usd(costs.todayUsd)}
                {limit !== null && <span className="muted"> / {usd(limit)}</span>}
              </strong>
            </div>
            {limit !== null && (
              <div className="meter" aria-hidden>
                <div className="meter-fill" style={{ width: `${Math.min(100, (costs.todayUsd / limit) * 100)}%` }} />
              </div>
            )}
          </>
        )}
        <div className="side-btn-row">
          <button className="side-btn" onClick={() => openSettings()} title={`Settings (${modKey()},)`}>
            <Icon name="gear" />
            Settings
          </button>
          <button className="side-btn side-btn-icon" onClick={onOpenShortcuts} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
            ?
          </button>
        </div>
        <button
          className="side-btn side-btn-danger"
          disabled={!anyRunning}
          title="Stop every running agent and clear all queues"
          onClick={() =>
            void attempt(async () => {
              await window.hangar.agents.stopAll()
              toast('All agents stopped.')
            })
          }
        >
          <Icon name="stop" />
          Stop all agents
        </button>
      </div>
    </aside>
  )
}

/** Claude Max mode: how much of the plan's 5-hour and weekly windows is used, against your limits. */
function PlanMeters({ plan, limits }: { plan: PlanUsage | null; limits: AppSettings['planLimits'] }) {
  const rows = [
    { label: '5-hour', w: plan?.fiveHour ?? null, limit: limits.fiveHourPct },
    { label: 'Week', w: plan?.weekly ?? null, limit: limits.weeklyPct }
  ]
  return (
    <>
      {rows.map(({ label, w, limit }) => (
        <div key={label} title={w ? `${w.usedPct}% of your Claude plan's ${label.toLowerCase()} usage; agents stop starting work at ${limit}%. ${resetsText(w.resetsAt)}` : 'Shows after the first run'}>
          <div className="spend">
            <span>{label}</span>
            <strong>
              {w ? `${w.usedPct}%` : '—'}
              <span className="muted"> / {limit}%</span>
            </strong>
          </div>
          <div className="meter" aria-hidden>
            <div className="meter-fill" style={{ width: `${Math.min(100, ((w?.usedPct ?? 0) / limit) * 100)}%` }} />
          </div>
        </div>
      ))}
      {plan?.blocked && <p className="small warn">Plan limit reached{plan.blocked.until ? `, ${resetsText(plan.blocked.until)}` : ''}.</p>}
    </>
  )
}
