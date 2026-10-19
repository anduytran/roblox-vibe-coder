import { addProject, attempt, selectProject, toast, useStore } from '../store'
import { Button, usd } from './ui'

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const projects = useStore((s) => s.projects)
  const selected = useStore((s) => s.selectedProjectId)
  const agents = useStore((s) => s.agents)
  const approvals = useStore((s) => s.approvals)
  const costs = useStore((s) => s.costs)
  const settings = useStore((s) => s.settings)

  const anyRunning = Object.values(agents).some((proj) =>
    Object.values(proj).some((a) => a.status === 'working' || a.status === 'awaiting_approval' || a.status === 'queued')
  )
  const limit = settings?.globalDailyBudgetUsd ?? null

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          ◢◣
        </span>
        Hangar
      </div>
      <div className="side-label">Projects</div>
      <ul className="project-list">
        {projects.map((p) => {
          const list = Object.values(agents[p.id] ?? {})
          const working = list.filter((a) => a.status === 'working').length
          const waiting = approvals.filter((a) => a.projectId === p.id).length
          const errored = list.some((a) => a.status === 'error')
          return (
            <li key={p.id}>
              <button className={`project-item ${selected === p.id ? 'project-item-active' : ''}`} onClick={() => selectProject(p.id)}>
                <span className={`dot ${waiting ? 'dot-warn' : working ? 'dot-live' : errored ? 'dot-err' : ''}`} />
                <span className="project-item-name">{p.name}</span>
                {waiting > 0 ? (
                  <span className="badge badge-warn" title="Actions waiting for your approval">
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
      <button className="add-project" onClick={() => void addProject()}>
        + Add project
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
        <Button tone="ghost" onClick={onOpenSettings}>
          Settings
        </Button>
        <Button
          tone="danger"
          disabled={!anyRunning}
          title="Stop every running agent and clear all queues"
          onClick={() =>
            void attempt(async () => {
              await window.hangar.agents.stopAll()
              toast('All agents stopped.')
            })
          }
        >
          Stop all agents
        </Button>
      </div>
    </aside>
  )
}
