import { useEffect, useState } from 'react'
import { AgentsView } from './components/AgentsView'
import { ChangesView } from './components/ChangesView'
import { ProjectSettingsView } from './components/ProjectSettingsView'
import { ReviewsView } from './components/ReviewsView'
import { SettingsModal } from './components/SettingsModal'
import { Dashboard } from './components/Dashboard'
import { IdeasPage } from './components/IdeasPage'
import { InboxPanel } from './components/InboxPanel'
import { ModelsView } from './components/ModelsView'
import { IdeaRefine } from './components/IdeaRefine'
import { NewGameWizard } from './components/NewGameWizard'
import { OverviewView } from './components/OverviewView'
import { Sidebar } from './components/Sidebar'
import { Avatar, Button, Icon } from './components/ui'
import { closeIdeaRefine, closeWizard, getState, setInboxOpen, setProjectTab, useStore, type ProjectTab } from './store'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ConfirmDialog } from './components/ConfirmDialog'


export function App() {
  const ready = useStore((s) => s.ready)
  const project = useStore((s) => s.projects.find((p) => p.id === s.selectedProjectId) ?? null)
  const hasKey = useStore((s) => s.key.ready)
  const toast = useStore((s) => s.toast)
  const pendingReviews = useStore((s) => (s.selectedProjectId ? (s.reviews[s.selectedProjectId] ?? []).filter((r) => r.status === 'pending').length : 0))
  const tab = useStore((s) => s.projectTab)
  const page = useStore((s) => s.page)
  const inboxOpen = useStore((s) => s.inboxOpen)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const wizardOpen = useStore((s) => s.wizard !== null)
  const refineOpen = useStore((s) => s.refineIdeaId !== null)
  // Cmd/Ctrl+I opens and closes the Inbox from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        const next = !getState().inboxOpen
        // Never open it underneath a dialog (it would be hidden, yet catch the next Esc).
        if (next && document.querySelector('.modal-backdrop')) return
        setInboxOpen(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
                {(['overview', 'agents', 'models', 'reviews', 'changes', 'settings'] as ProjectTab[]).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setProjectTab(t)}>
                    <Icon name={t === 'overview' ? 'home' : t === 'agents' ? 'agents' : t === 'models' ? 'cube' : t === 'reviews' ? 'review' : t === 'changes' ? 'changes' : 'sliders'} />
                    {t === 'overview' ? 'Overview' : t === 'agents' ? 'Agents' : t === 'models' ? '3D' : t === 'reviews' ? 'Reviews' : t === 'changes' ? 'Changes' : 'Project'}
                    {t === 'reviews' && pendingReviews > 0 && <span className="badge badge-warn tab-badge">{pendingReviews}</span>}
                  </button>
                ))}
              </nav>
            </header>
            <section className="view" key={`${project.id}-${tab}`}>
              <ErrorBoundary label="this tab">
                {tab === 'overview' && <OverviewView project={project} onOpenReviews={() => setProjectTab('reviews')} />}
                {tab === 'agents' && <AgentsView project={project} />}
                {tab === 'models' && <ModelsView project={project} />}
                {tab === 'reviews' && <ReviewsView project={project} />}
                {tab === 'changes' && <ChangesView project={project} />}
                {tab === 'settings' && <ProjectSettingsView project={project} />}
              </ErrorBoundary>
            </section>
          </>
        ) : page === 'ideas' ? (
          <ErrorBoundary key="ideas" label="Ideas">
            <IdeasPage />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary key="home" label="Home">
            <Dashboard />
          </ErrorBoundary>
        )}
      </main>
      {settingsOpen && (
        <ErrorBoundary label="Settings" onClose={() => setSettingsOpen(false)}>
          <SettingsModal onClose={() => setSettingsOpen(false)} />
        </ErrorBoundary>
      )}
      {wizardOpen && (
        <ErrorBoundary label="New game" onClose={closeWizard}>
          <NewGameWizard />
        </ErrorBoundary>
      )}
      {inboxOpen && (
        <ErrorBoundary label="the Inbox" onClose={() => setInboxOpen(false)}>
          <InboxPanel />
        </ErrorBoundary>
      )}
      {refineOpen && (
        <ErrorBoundary label="this idea" onClose={closeIdeaRefine}>
          <IdeaRefine />
        </ErrorBoundary>
      )}
      <ConfirmDialog />
      {toast && (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  )
}
