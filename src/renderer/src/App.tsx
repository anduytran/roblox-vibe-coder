import { useEffect, useState } from 'react'
import { AgentsView } from './components/AgentsView'
import { ChangesView } from './components/ChangesView'
import { ProjectSettingsView } from './components/ProjectSettingsView'
import { ReviewsView } from './components/ReviewsView'
import { SettingsModal } from './components/SettingsModal'
import { Dashboard } from './components/Dashboard'
import { NewGameWizard } from './components/NewGameWizard'
import { OverviewView } from './components/OverviewView'
import { Sidebar } from './components/Sidebar'
import { Avatar, Button, Icon } from './components/ui'
import { useStore } from './store'

type Tab = 'overview' | 'agents' | 'reviews' | 'changes' | 'settings'

export function App() {
  const ready = useStore((s) => s.ready)
  const project = useStore((s) => s.projects.find((p) => p.id === s.selectedProjectId) ?? null)
  const hasKey = useStore((s) => s.key.hasKey)
  const toast = useStore((s) => s.toast)
  const pendingReviews = useStore((s) => (s.selectedProjectId ? (s.reviews[s.selectedProjectId] ?? []).filter((r) => r.status === 'pending').length : 0))
  const [tab, setTab] = useState<Tab>('overview')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const wizardOpen = useStore((s) => s.wizard !== null)
  const projectId = project?.id
  // Each project opens on its Overview.
  useEffect(() => setTab('overview'), [projectId])

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
                <Avatar name={project.name} />
                <div className="project-title-text">
                <h1>{project.name}</h1>
                <span className="project-path" title={project.path}>
                  {project.path}
                </span>
                </div>
              </div>
              <nav className="tabs" role="tablist">
                {(['overview', 'agents', 'reviews', 'changes', 'settings'] as Tab[]).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
                    <Icon name={t === 'overview' ? 'home' : t === 'agents' ? 'agents' : t === 'reviews' ? 'review' : t === 'changes' ? 'changes' : 'sliders'} />
                    {t === 'overview' ? 'Overview' : t === 'agents' ? 'Agents' : t === 'reviews' ? 'Reviews' : t === 'changes' ? 'Changes' : 'Settings'}
                    {t === 'reviews' && pendingReviews > 0 && <span className="badge badge-warn tab-badge">{pendingReviews}</span>}
                  </button>
                ))}
              </nav>
            </header>
            <section className="view">
              {tab === 'overview' && <OverviewView project={project} onOpenReviews={() => setTab('reviews')} />}
              {tab === 'agents' && <AgentsView project={project} />}
              {tab === 'reviews' && <ReviewsView project={project} />}
              {tab === 'changes' && <ChangesView project={project} />}
              {tab === 'settings' && <ProjectSettingsView project={project} />}
            </section>
          </>
        ) : (
          <Dashboard />
        )}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {wizardOpen && <NewGameWizard />}
      {toast && (
        <div className={`toast toast-${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  )
}
