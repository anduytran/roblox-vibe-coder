import { useCallback, useState } from 'react'
import { AgentsView } from './components/AgentsView'
import { DesignView } from './components/DesignView'
import { FilesView } from './components/FilesView'
import { StudioSyncControl } from './components/StudioSyncControl'
import { UncommittedDialog } from './components/UncommittedDialog'
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
import { closeIdeaRefine, closeSettings, closeWizard, openSettings, PROJECT_TABS, setInboxOpen, setProjectTab, useStore } from './store'
import { modKey, ShortcutsHelp, Switcher, useShortcuts } from './components/Shortcuts'
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
  const settingsTab = useStore((s) => s.settingsTab)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), [])
  const wizardOpen = useStore((s) => s.wizard !== null)
  const refineOpen = useStore((s) => s.refineIdeaId !== null)
  // Cmd/Ctrl+1…8, K, I and comma, and "?" (never underneath an open dialog).
  useShortcuts({ switcherOpen, setSwitcher: setSwitcherOpen, setHelp: setHelpOpen })

  if (!ready) return <div className="boot">Starting Hangar…</div>

  return (
    <div className="app">
      <Sidebar onOpenShortcuts={() => setHelpOpen(true)} />
      <main className="main">
        {!hasKey && (
          <div className="banner">
            Add your Anthropic API key to start running agents.
            <Button size="sm" tone="primary" onClick={() => openSettings('account')}>
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
                <h1 title={project.path}>{project.name}</h1>
                <StudioSyncControl project={project} />
                </div>
              </div>
              <nav className="tabs" role="tablist">
                {PROJECT_TABS.map((t, i) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    aria-keyshortcuts={`${window.hangar.platform === 'darwin' ? 'Meta' : 'Control'}+${i + 1}`}
                    title={`${modKey()}${i + 1}`}
                    className={`tab ${tab === t ? 'tab-active' : ''}`}
                    onClick={() => setProjectTab(t)}
                  >
                    <Icon name={t === 'overview' ? 'home' : t === 'design' ? 'book' : t === 'agents' ? 'agents' : t === 'models' ? 'cube' : t === 'reviews' ? 'review' : t === 'changes' ? 'changes' : t === 'files' ? 'folder' : 'sliders'} />
                    {t === 'overview' ? 'Overview' : t === 'design' ? 'Design' : t === 'agents' ? 'Agents' : t === 'models' ? '3D' : t === 'reviews' ? 'Reviews' : t === 'changes' ? 'Changes' : t === 'files' ? 'Files' : 'Project'}
                    {t === 'reviews' && pendingReviews > 0 && <span className="badge badge-warn tab-badge">{pendingReviews}</span>}
                  </button>
                ))}
              </nav>
            </header>
            <section className="view" key={`${project.id}-${tab}`}>
              <ErrorBoundary label="this tab">
                {tab === 'overview' && <OverviewView project={project} onOpenReviews={() => setProjectTab('reviews')} />}
                {tab === 'design' && <DesignView project={project} />}
                {tab === 'agents' && <AgentsView project={project} />}
                {tab === 'models' && <ModelsView project={project} />}
                {tab === 'reviews' && <ReviewsView project={project} />}
                {tab === 'changes' && <ChangesView project={project} />}
                {tab === 'files' && <FilesView project={project} />}
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
      {settingsTab && (
        <ErrorBoundary label="Settings" onClose={closeSettings}>
          <SettingsModal initialTab={settingsTab} onClose={closeSettings} />
        </ErrorBoundary>
      )}
      {switcherOpen && (
        <ErrorBoundary label="the switcher" onClose={closeSwitcher}>
          <Switcher onClose={closeSwitcher} />
        </ErrorBoundary>
      )}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
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
      <UncommittedDialog />
      <ConfirmDialog />
      {toast && (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  )
}
