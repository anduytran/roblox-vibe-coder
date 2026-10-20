import { useState } from 'react'
import { AgentsView } from './components/AgentsView'
import { ChangesView } from './components/ChangesView'
import { ProjectSettingsView } from './components/ProjectSettingsView'
import { ReviewsView } from './components/ReviewsView'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { Button } from './components/ui'
import { addProject, useStore } from './store'

type Tab = 'agents' | 'reviews' | 'changes' | 'settings'

export function App() {
  const ready = useStore((s) => s.ready)
  const project = useStore((s) => s.projects.find((p) => p.id === s.selectedProjectId) ?? null)
  const hasKey = useStore((s) => s.key.hasKey)
  const toast = useStore((s) => s.toast)
  const pendingReviews = useStore((s) => (s.selectedProjectId ? (s.reviews[s.selectedProjectId] ?? []).filter((r) => r.status === 'pending').length : 0))
  const [tab, setTab] = useState<Tab>('agents')
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (!ready) return <div className="boot">Starting Hangar…</div>

  return (
    <div className="app">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      <main className="main">
        {!hasKey && (
          <div className="banner">
            Add your Anthropic API key to start running agents.
            <Button size="sm" tone="primary" onClick={() => setSettingsOpen(true)}>
              Open settings
            </Button>
          </div>
        )}
        {project ? (
          <>
            <header className="project-head">
              <div className="project-title">
                <h1>{project.name}</h1>
                <span className="project-path" title={project.path}>
                  {project.path}
                </span>
              </div>
              <nav className="tabs" role="tablist">
                {(['agents', 'reviews', 'changes', 'settings'] as Tab[]).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
                    {t === 'agents' ? 'Agents' : t === 'reviews' ? 'Reviews' : t === 'changes' ? 'Changes' : 'Project settings'}
                    {t === 'reviews' && pendingReviews > 0 && <span className="badge badge-warn tab-badge">{pendingReviews}</span>}
                  </button>
                ))}
              </nav>
            </header>
            <section className="view">
              {tab === 'agents' && <AgentsView project={project} />}
              {tab === 'reviews' && <ReviewsView project={project} />}
              {tab === 'changes' && <ChangesView project={project} />}
              {tab === 'settings' && <ProjectSettingsView project={project} />}
            </section>
          </>
        ) : (
          <div className="empty">
            <h1>Welcome to Hangar</h1>
            <p>Add a project folder (for example your Rojo repo) to give it its own team of Claude agents.</p>
            <Button tone="primary" onClick={() => void addProject()}>
              Add a project folder
            </Button>
          </div>
        )}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {toast && (
        <div className={`toast toast-${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  )
}
