import { addProject, attempt, openWizard, selectProject, toast, useStore } from '../store'
import { Avatar, Icon, usd } from './ui'

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const projects = useStore((s) => s.projects)
  const selected = useStore((s) => s.selectedProjectId)
  const agents = useStore((s) => s.agents)
  const approvals = useStore((s) => s.approvals)
  const costs = useStore((s) => s.costs)
  const settings = useStore((s) => s.settings)
  const autopilot = useStore((s) => s.autopilot)

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
      <button className={`side-btn side-nav ${selected === null ? 'side-btn-active' : ''}`} onClick={() => selectProject(null)}>
        <Icon name="home" />
        Home
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

      <div className="side-foot">
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
        <button className="side-btn" onClick={onOpenSettings}>
          <Icon name="gear" />
          Settings
        </button>
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
